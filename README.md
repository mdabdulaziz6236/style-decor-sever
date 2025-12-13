# 🏡 StyleDecor Server - Backend API

![NodeJS](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![ExpressJS](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-4EA94B?style=for-the-badge&logo=mongodb&logoColor=white)
![JWT](https://img.shields.io/badge/JWT-black?style=for-the-badge&logo=JSON%20web%20tokens)

## 📋 Project Overview
This is the backend server for **StyleDecor**, a Smart Home & Ceremony Decoration Booking System. It provides RESTful APIs to handle user authentication, booking management, service data, and secure payment processing via Stripe.

## 🔗 Live URL
- **Server Base URL:** [https://style-dec-server.vercel.app](https://style-dec-server.vercel.app)

---

## ✨ Key Features
- **Secure Authentication:** JSON Web Token (JWT) verification for protected routes.
- **Database Management:** MongoDB CRUD operations for Services, Bookings, and Users.
- **Payment Processing:** Integrated Stripe Payment Intent API for secure transactions.
- **Role-Based Access Control:** Verify Admin and Decorator roles using custom middleware.
- **Data Aggregation:** Advanced MongoDB aggregation for Admin Dashboard statistics (Charts).
- **Search & Filter:** APIs for searching services and filtering by price/category.

---

## 🛠️ Technology Stack
- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** MongoDB (via native driver)
- **Authentication:** JWT (jsonwebtoken)
- **Payment:** Stripe
- **Tools:** Dotenv, Cors

---

## ⚙️ Environment Variables

To run this server locally, create a `.env` file in the root directory and add the following credentials:

```env
# Server Port
PORT=3000

# MongoDB Credentials
DB_USER=your_db_username
DB_PASS=your_db_password

# JWT Secret Token (Run 'require("crypto").randomBytes(64).toString("hex")' in node to generate)
ACCESS_TOKEN_SECRET=your_super_secret_token

# Stripe Secret Key
STRIPE_SECRET_KEY=your_stripe_secret_key
