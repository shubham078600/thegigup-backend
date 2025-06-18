// IMPORT STATEMENTS
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import compression from 'compression';

import {PrismaClient} from './generated/prisma/client.js'; // 
const prisma = new PrismaClient();

import { flRouter } from './freelancer/freelancer.js';
import { clientRouter } from './client/client.js';
import { publicRouter } from './publicRoutes/publicroutes.js';
import { adminRouter } from './admin/admin.js';
import transporter  from './nodemailer.config.js'; // Importing the nodemailer configuration
import emailRouter from './routes/emailVerification.js';

const PORT = process.env.PORT || 3000;

const app = express();



// const mailOptions = {
//   from: "email",
//   to: "email",
//   subject: "title",
//   text: "message",
// };


// transporter.sendMail(mailOptions, (error, info) => {
//   if (error) {
//     console.error("Error:", error);
//   } else {
//     console.log("Email sent:", info.response);
//   }
// });

dotenv.config();


app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/v1/freelancer', flRouter);
app.use('/api/v1/client', clientRouter);
app.use('/api/v1/public', publicRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/email', emailRouter);


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
