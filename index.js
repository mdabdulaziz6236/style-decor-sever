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
    return res.status(401).send({ message: "unauthorized access" });
  }
  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorized access" });
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
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };
    const verifyDecorator = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "decorator") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };
    const logTracking = async (trackingId, status, customDetails = null) => {
      const existing = await trackingsCollection.findOne({
        trackingId,
        status,
      });
      if (existing) return null;
      const log = {
        trackingId,
        status: status.split("_").join(" "),
        details: customDetails || status.split("-").join(" "),
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
            transactionId: session.payment_intent,
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
    /* ADMIN STAT API */
    app.get(
      "/admin-stats",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const totalUsers = await usersCollection.estimatedDocumentCount();
          const totalBookings =
            await bookingsCollection.estimatedDocumentCount();
          const totalServices =
            await servicesCollection.estimatedDocumentCount();

          // Revenue Calculation
          const revenueResult = await paymentsCollection
            .aggregate([
              { $group: { _id: null, totalRevenue: { $sum: "$amount" } } },
            ])
            .toArray();
          const totalRevenue =
            revenueResult.length > 0 ? revenueResult[0].totalRevenue : 0;
          // Service Demand Chart
          const serviceDemand = await bookingsCollection
            .aggregate([
              { $group: { _id: "$service_name", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 6 },
            ])
            .toArray();
          // Booking Status Chart
          const bookingStatus = await bookingsCollection
            .aggregate([
              { $group: { _id: "$serviceStatus", count: { $sum: 1 } } },
            ])
            .toArray();
          const recentBookings = await bookingsCollection
            .aggregate([
              { $sort: { createdAt: -1 } },
              { $limit: 10 },
              {
                $lookup: {
                  from: "trackings",
                  let: { booking_trackingId: "$trackingId" },
                  pipeline: [
                    {
                      $match: {
                        $expr: { $eq: ["$trackingId", "$$booking_trackingId"] },
                      },
                    },
                    { $sort: { createdAt: -1 } },
                  ],
                  as: "trackingHistory",
                },
              },
            ])
            .toArray();

          res.send({
            totalUsers,
            totalBookings,
            totalServices,
            totalRevenue,
            serviceDemand,
            bookingStatus,
            recentBookings,
          });
        } catch (error) {
          console.error(error);
          res.status(500).send({ message: "Error fetching admin stats" });
        }
      }
    );
    /* USERS APIS */
    /* USER STAT APIS */
    app.get("/user-stats/:email", verifyFirebaseToken, async (req, res) => {
      const email = req.params.email;
      if (req.decoded_email !== email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      try {
        const query = { user_email: email };
        const totalBookings = await bookingsCollection.countDocuments(query);
        const payments = await paymentsCollection.aggregate([
          { $match: { customerEmail: email } },
          { $group: { _id: null, totalSpent: { $sum: "$amount" } } }
        ]).toArray();
        const totalSpent = payments.length > 0 ? payments[0].totalSpent : 0;
        const pendingBookings = await bookingsCollection.countDocuments({
           user_email: email, 
           paymentStatus: 'pending'
        });
        const myBookings = await bookingsCollection.aggregate([
          { $match: { user_email: email } },
          { $sort: { createdAt: -1 } },
          { $limit: 5 },
          {
            $lookup: {
              from: "trackings",
              let: { booking_trackingId: "$trackingId" },
              pipeline: [
                { $match: { $expr: { $eq: ["$trackingId", "$$booking_trackingId"] } } },
                { $sort: { createdAt: -1 } }
              ],
              as: "trackingHistory"
            }
          }
        ]).toArray();

        res.send({
          totalBookings,
          totalSpent,
          pendingBookings,
          myBookings
        });

      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Error fetching user stats" });
      }
    });
    /* MANAGE USER  */
    app.get('/users-for-admin', verifyFirebaseToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });
    app.patch('/users/admin/:id', verifyFirebaseToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          role: 'admin'
        }
      };
      const result = await usersCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });
    app.delete('/users/:id', verifyFirebaseToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      try {
        const user = await usersCollection.findOne(query);

        if (!user) {
          return res.status(404).send({ message: "User not found in database" });
        }
        try {
            const firebaseUser = await admin.auth().getUserByEmail(user.email);
            await admin.auth().deleteUser(firebaseUser.uid);
            console.log("Successfully deleted user from Firebase:", user.email);
        } catch (firebaseError) {
            console.log("Error deleting from Firebase (might not exist):", firebaseError.message);
        }
        const result = await usersCollection.deleteOne(query);
        res.send(result);

      } catch (error) {
        console.error("Error in delete API:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });
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
    //  DECORATOR EARNINGS API
    app.get(
      "/decorator/earnings",
      verifyFirebaseToken,
      verifyDecorator,
      async (req, res) => {
        try {
          const email = req.query.email;
          const query = {
            decoratorEmail: email,
            paymentStatus: "paid",
            serviceStatus: "Completed",
          };

          const bookings = await bookingsCollection
            .find(query)
            .sort({ booking_date: -1 })
            .toArray();
          const totalEarnings = bookings.reduce((sum, item) => {
            const cost = parseFloat(item.service_cost);
            return sum + (isNaN(cost) ? 0 : cost);
          }, 0);
          const completedTasks = bookings.length;
          const chartData = bookings
            .slice(0, 6)
            .map((item) => {
              const dateObj = new Date(item.booking_date);
              const dateStr = !isNaN(dateObj)
                ? dateObj.toLocaleDateString("en-US", {
                    day: "numeric",
                    month: "short",
                  })
                : "N/A";

              return {
                name: item.service_name?.substring(0, 10) + "...", // Short name
                date: dateStr,
                amount: parseFloat(item.service_cost || 0),
              };
            })
            .reverse();

          res.send({
            totalEarnings,
            completedTasks,
            bookings,
            chartData,
          });
        } catch (error) {
          console.error("Earnings API Error:", error);
          res
            .status(500)
            .send({ message: "Internal Server Error", error: error.message });
        }
      }
    );
    // ---------------------------------------------------------
    //  DECORATOR HOME STATS API (Clean Data Only)
    // ---------------------------------------------------------
    app.get(
      "/decorator/stats/homepage",
      verifyFirebaseToken,
      verifyDecorator,
      async (req, res) => {
        try {
          const email = req.query.email;
          if (req.decoded_email !== email) {
            return res.status(403).send({ message: "forbidden access" });
          }
          const query = { decoratorEmail: email };
          const allTasks = await bookingsCollection.find(query).toArray();
          // 1. Calculations
          const totalAssigned = allTasks.length;
          const pendingCount = allTasks.filter(
            (task) => task.serviceStatus === "Decorator_Assigned"
          ).length;
          const acceptedCount = allTasks.filter(
            (task) => task.serviceStatus === "Decorator_Accepted"
          ).length;
          const workingCount = allTasks.filter(
            (task) => task.serviceStatus === "Working"
          ).length;
          const completedCount = allTasks.filter(
            (task) => task.serviceStatus === "Completed"
          ).length;

          // 2. Earnings
          const totalEarnings = allTasks.reduce((sum, task) => {
            if (
              task.paymentStatus === "paid" &&
              task.serviceStatus === "Completed"
            ) {
              return sum + (parseFloat(task.service_cost) || 0);
            }
            return sum;
          }, 0);

          // 3. Pie Chart Data
          const pieData = [
            { name: "Assigned", value: pendingCount },
            { name: "Accepted", value: acceptedCount },
            { name: "Working", value: workingCount },
            { name: "Completed", value: completedCount },
          ];
          const recentBookings = await bookingsCollection
            .find(query)
            .sort({ assignedAt: -1 })
            .limit(5)
            .toArray();

          res.send({
            totalAssigned,
            activeTasks: workingCount,
            completedTasks: completedCount,
            totalEarnings,
            pieData,
            recentBookings,
          });
        } catch (error) {
          console.error("Stats API Error:", error);
          res.status(500).send({ message: "Internal Server Error" });
        }
      }
    );
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
          await logTracking(trackingId, serviceStatus, details);
        }

        res.send(result);
      }
    );
    // GET: Fetch Tasks for specific Decorator
    app.get(
      "/bookings/assigned",
      verifyFirebaseToken,
      verifyDecorator,
      async (req, res) => {
        const email = req.query.email;
        if (req.decoded_email !== email) {
          return res.status(403).send({ message: "forbidden access" });
        }
        const query = { decoratorEmail: email };

        const result = await bookingsCollection
          .find(query)
          .sort({ booking_date: -1 })
          .toArray();
        res.send(result);
      }
    );
    /* update booking status from decorator */
    app.patch(
      "/bookings/decorator-status/:id",
      verifyFirebaseToken,
      verifyDecorator,
      async (req, res) => {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };

        const { serviceStatus, trackingId, details } = req.body;
        const updatedDoc = {
          $set: {
            serviceStatus: serviceStatus,
          },
        };
        const result = await bookingsCollection.updateOne(filter, updatedDoc);
        if (result.modifiedCount > 0 && trackingId) {
          await logTracking(trackingId, serviceStatus, details);
        }

        res.send(result);
      }
    );
    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
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
