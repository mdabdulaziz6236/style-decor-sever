const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 3000;
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const serviceAccount = require(`./${process.env.FIREBASE_SERVICE_ACCOUNT}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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
    app.post("/bookings", async (req, res) => {
      const bookingsInfo = req.body;
      (bookingsInfo.createdAt = new Date()),
        (bookingsInfo.status = "pending"),
        (bookingsInfo.paymentStatus = "pending");
      const result = await bookingsCollection.insertOne(bookingsInfo);
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
