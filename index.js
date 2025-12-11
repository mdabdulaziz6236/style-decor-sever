const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 3000;
const admin = require("firebase-admin");
const crypto = require("crypto");

const serviceAccount = require(`./${process.env.FIREBASE_SERVICE_ACCOUNT}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
// --- Tracking ID Generator Function ---
const generateTrackingId = () => {
  const prefix = "TSD";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${date}-${random}`;
};
/* middleware */
app.use(express.json());
app.use(cors());

const verifyFirebaseToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) {
    res.status(401).send({ message: "unauthorized access" });
  }
  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    res.status(401).send({ message: "unauthorized access" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.jdeeqhi.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("style-decor-db");
    const usersCollection = db.collection("users");
    const contactCollection = db.collection("contact");
    const decoratorsCollection = db.collection("decorators");
    const servicesCollection = db.collection("services");
    const bookingsCollection = db.collection("bookings");
    const trackingsCollection = db.collection("trackings");
    const paymentsCollection = db.collection("payments");

    /* --------------MIDDLE ADMIN BEFORE ALLOWING ADMIN ACTIVITY------------- */
    /* --------------!!! MUST BE USED AFTER VerifyFBToken !!!!------------- */

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };
    const verifyDecorator = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "decorator") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };
    const logTracking = async (trackingId, status) => {
      const existing = await trackingsCollection.findOne({
        trackingId,
        status,
      });
      if (existing) return null;
      const log = {
        trackingId,
        status,
        details: status.split("-").join(" "),
        createdAt: new Date(),
      };
      const result = await trackingsCollection.insertOne(log);
      return result;
    };
    /* --------------------------------- */
    /* Service Related APIS */
    /* --------------------------------- */

    app.get("/bookings/track/:trackingId", async (req, res) => {
      const trackingId = req.params.trackingId;
      const query = { trackingId };
      const result = await trackingsCollection.find(query).toArray();
      res.send(result);
    });
    /* --------------------------------- */
    /* payment Related APIS */
    /* --------------------------------- */
    app.post("/payment-checkout-session", async (req, res) => {
      const bookingInfo = req.body;
      const amount = parseInt(bookingInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "BDT",
              unit_amount: amount,
              product_data: {
                name: `Please pay for ${bookingInfo.bookingName}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          bookingId: bookingInfo.bookingId,
          bookingName: bookingInfo.bookingName,
          trackingId: bookingInfo.trackingId,
        },
        customer_email: bookingInfo.userEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };
      // reduce repeat add form database
      const paymentExist = await paymentsCollection.findOne(query);
      if (paymentExist) {
        return res.send({
          message: "already exists",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }
      // use the previous tracking id created during the parcel create which was set to the session metadata during session creation
      if (session.payment_status === "paid") {
        const trackingId = session.metadata.trackingId;
        const id = session.metadata.bookingId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            serviceStatus: "pending-assign",
          },
        };
        const result = await bookingsCollection.updateOne(query, update);
        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          bookingId: session.metadata.bookingId,
          service_name: session.metadata.bookingName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        const resultPayment = await paymentsCollection.insertOne(payment);
        await logTracking(trackingId, "booking-paid");
        return res.send({
          success: true,
          modifyBooking: result,
          trackingId: trackingId,
          transactionId: session.payment_intent,
          paymentInfo: resultPayment,
        });
      }
      return res.send({ success: false });
    });
    app.get("/payments", async (req, res) => {
      const email = req.query.email;
      const query = { customerEmail: email };
      const result = await paymentsCollection.find(query).toArray();
      res.send(result);
    });
    /* USERS APIS */
    /* create user */
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        return res.send({ message: "user exist" });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });
    /* get role from user */
    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });
    /* get user info by email */
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const result = await usersCollection.findOne(query);
      res.send(result);
    });
    app.patch("/users/:email", async (req, res) => {
      const email = req.params.email;
      const updateDoc = req.body;
      const filter = { email: email };
      const update = {
        $set: updateDoc,
      };
      const result = await usersCollection.updateOne(filter, update);
      res.send(result);
    });
    /* User Contact message related APIS */
    app.post("/contact", async (req, res) => {
      const messageData = req.body;
      const result = await contactCollection.insertOne(messageData);
      res.send(result);
    });
    /* --------------------------------- */
    /* Decorators Related APIS */
    /* --------------------------------- */
    app.post("/decorators", async (req, res) => {
      const decorator = req.body;
      decorator.status = "pending";
      decorator.createdAt = new Date();
      const result = await decoratorsCollection.insertOne(decorator);
      res.send(result);
    });
    app.get("/decorators", async (req, res) => {
      const query = {};
      const result = await decoratorsCollection.find(query).toArray();
      res.send(result);
    });
    app.patch("/decorators/:id", async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: status,
          workStatus: "available",
        },
      };
      const result = await decoratorsCollection.updateOne(query, updateDoc);
      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "decorator",
          },
        };
        const userResult = await usersCollection.updateOne(
          userQuery,
          updateUser
        );
      }
      if (status === "rejected") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "user",
          },
        };
        const userResult = await usersCollection.updateOne(
          userQuery,
          updateUser
        );
      }
      res.send(result);
    });
    app.delete("/decorators/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await decoratorsCollection.deleteOne(query);
      res.send(result);
    });
    /* --------------------------------- */
    /* Service Related APIS */
    /* --------------------------------- */
    // Get All Services with Filter, Search & Sort
    app.get("/services", async (req, res) => {
      const search = req.query.search;
      const category = req.query.category;
      const sort = req.query.sort;

      // Pagination params
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 100;
      const skip = (page - 1) * limit;

      let query = { status: "active" };

      if (search) {
        query.service_name = { $regex: search, $options: "i" };
      }
      if (category) {
        query.category = category;
      }

      let sortOptions = {};
      if (sort === "asc") {
        sortOptions = { cost: 1 };
      } else if (sort === "desc") {
        sortOptions = { cost: -1 };
      }
      const result = await servicesCollection
        .find(query)
        .sort(sortOptions)
        .skip(skip)
        .limit(limit)
        .toArray();
      const totalCount = await servicesCollection.countDocuments(query);

      res.send({ result, count: totalCount });
    });

    // Get Single Service Details
    app.get("/services/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await servicesCollection.findOne(query);
      res.send(result);
    });
    app.post("/services", async (req, res) => {
      const servicesInfo = req.body;
      const result = await servicesCollection.insertOne(servicesInfo);
      res.send(result);
    });
    /* --------------------------------- */
    /* bookings Related APIS */
    /* --------------------------------- */
    app.post("/bookings", verifyFirebaseToken, async (req, res) => {
      const bookingsInfo = req.body;
      (bookingsInfo.createdAt = new Date()),
        (bookingsInfo.trackingId = generateTrackingId()),
        (bookingsInfo.serviceStatus = "pending"),
        (bookingsInfo.paymentStatus = "pending");
      const trackingId = bookingsInfo.trackingId;

      const result = await bookingsCollection.insertOne(bookingsInfo);
      await logTracking(trackingId, "booking-Placed");
      res.send(result);
    });
    app.get("/bookings", verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;
      const query = { user_email: email };
      const result = await bookingsCollection.find(query).toArray();
      res.send(result);
    });
    app.delete("/bookings/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await bookingsCollection.deleteOne(query);
      res.send(result);
    });
    app.patch("/bookings/:id", async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const bookingsUpdData = req.body;
      const updateDoc = {
        $set: {
          ...bookingsUpdData,
        },
      };
      const result = await bookingsCollection.updateOne(filter, updateDoc);
      res.send(result);
    });
    // ---------------------------------------------------------
    // ASSIGN DECORATOR RELATED APIs
    // ---------------------------------------------------------
    app.get(
      "/bookings-assign",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const serviceStatus = req.query.serviceStatus;
        const paymentStatus = req.query.paymentStatus;

        let query = {};
        if (serviceStatus) {
          query.serviceStatus = serviceStatus;
        }

        if (paymentStatus) {
          query.paymentStatus = paymentStatus;
        }

        const result = await bookingsCollection.find(query).toArray();
        res.send(result);
      }
    );

    // 2. GET: Fetch Decorators (Filtered by District)
    app.get(
      "/decorators/available",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const district = req.query.district;
        let query = {
          workStatus: "available",
          status: "approved",
        };
        if (district) {
          query.district = { $regex: district, $options: "i" };
        }

        const result = await decoratorsCollection.find(query).toArray();
        res.send(result);
      }
    );

    // 3. PATCH: Assign Decorator (Update Status & Log)
    app.patch(
      "/bookings/status/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const {
          serviceStatus,
          decoratorId,
          decoratorName,
          decoratorEmail,
          trackingId,
          details,
        } = req.body;

        const updatedDoc = {
          $set: {
            serviceStatus: serviceStatus,
            decoratorId: decoratorId,
            decoratorName: decoratorName,
            decoratorEmail: decoratorEmail,
            assignedAt: new Date(),
            details: details,
          },
        };

        const result = await bookingsCollection.updateOne(filter, updatedDoc);
        if (result.modifiedCount > 0 && trackingId) {
          await logTracking(trackingId, serviceStatus);
        }

        res.send(result);
      }
    );
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Alhamdulillah. Server is styling....!");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
