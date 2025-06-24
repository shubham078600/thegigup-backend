import { Router } from 'express';
import { 
    sendVerificationOTP, 
    verifyEmailOTP, 
    checkEmailRegistrationStatus 
} from '../controllers/emailVerification.js';

const emailRouter = Router();

// Send email verification OTP
emailRouter.post('/send-verification-otp', sendVerificationOTP);

// Verify email OTP
emailRouter.post('/verify-otp', verifyEmailOTP);

// Check email registration status
emailRouter.get('/check-registration/:email', checkEmailRegistrationStatus);

export default emailRouter;