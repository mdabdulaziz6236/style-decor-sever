const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 3000;
require('dotenv').config()

/* middleware */
app.use(express.json());
app.use(cors());


app.get("/", (req, res) => {
  res.send("Alhamdulillah. Server is styling....!");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
