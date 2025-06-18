import { PrismaClient } from '../generated/prisma/index.js';
import { 
    generateEmailVerificationOTP, 
    storeEmailVerificationOTP, 
    verifyEmailVerificationOTP, 
    sendEmailVerificationOTP,
    checkEmailRegistration
} from '../utils/emailVerification.js';
import { setCache, getCache } from '../utils/redis.js';

const prisma = new PrismaClient();

// Helper function to validate email
const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

// POST /api/email/send-verification-otp
export const sendVerificationOTP = async (req, res) => {
    try {
        const { email } = req.body;
        console.log('Received email for verification:', email);
        
        // Validation
        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        if (!isValidEmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid email address'
            });
        }

        // Check if email is already registered
        const registrationCheck = await checkEmailRegistration(email);
        
        if (registrationCheck.registered) {
            return res.status(409).json({
                success: false,
                message: registrationCheck.message,
                data: {
                    registered: true,
                    userType: registrationCheck.userType
                }
            });
        }

        // Check rate limiting (prevent spam)
        const rateLimitKey = `email_verification_rate_limit:${email}`;
        const existingRequest = await getCache(rateLimitKey);
        
        if (existingRequest) {
            return res.status(429).json({
                success: false,
                message: 'OTP already sent. Please wait 2 minutes before requesting again.'
            });
        }

        // Generate OTP
        const otp = generateEmailVerificationOTP();
        
        // Store OTP in Redis
        await storeEmailVerificationOTP(email, otp);
        
        // Set rate limiting (2 minutes)
        await setCache(rateLimitKey, true, 120);

        // Send OTP email
        await sendEmailVerificationOTP(email, otp);

        res.status(200).json({
            success: true,
            message: 'Verification OTP has been sent to your email address.',
            data: {
                otpSent: true,
                email: email,
                expiresIn: '10 minutes'
            }
        });

    } catch (error) {
        console.error('Send email verification OTP error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error. Please try again later.',
            error: error.message
        });
    }
};

// POST /api/email/verify-otp
export const verifyEmailOTP = async (req, res) => {
    try {
        const { email, otp } = req.body;

        // Validation
        if (!email || !otp) {
            return res.status(400).json({
                success: false,
                message: 'Email and OTP are required'
            });
        }

        if (!isValidEmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid email address'
            });
        }

        if (otp.length !== 6 || !/^\d{6}$/.test(otp)) {
            return res.status(400).json({
                success: false,
                message: 'OTP must be 6 digits'
            });
        }

        // Check if email is already registered (double-check)
        const registrationCheck = await checkEmailRegistration(email);
        
        if (registrationCheck.registered) {
            return res.status(409).json({
                success: false,
                message: registrationCheck.message,
                data: {
                    registered: true,
                    userType: registrationCheck.userType
                }
            });
        }

        // Verify OTP
        const verification = await verifyEmailVerificationOTP(email, otp);
        
        if (!verification.valid) {
            return res.status(400).json({
                success: false,
                message: verification.error
            });
        }

        res.status(200).json({
            success: true,
            message: 'Email verified successfully. You can now proceed with registration.',
            data: {
                verified: true,
                email: email,
                canProceedWithRegistration: true,
                verifiedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Email verification OTP verify error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error. Please try again later.',
            error: error.message
        });
    }
};

// GET /api/email/check-registration/:email
export const checkEmailRegistrationStatus = async (req, res) => {
    try {
        const { email } = req.params;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        if (!isValidEmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid email address'
            });
        }

        // Check if email is already registered
        const registrationCheck = await checkEmailRegistration(email);
        
        if (registrationCheck.registered) {
            return res.status(200).json({
                success: true,
                message: registrationCheck.message,
                data: {
                    registered: true,
                    userType: registrationCheck.userType,
                    available: false
                }
            });
        }

        res.status(200).json({
            success: true,
            message: 'Email is available for registration',
            data: {
                registered: false,
                available: true
            }
        });

    } catch (error) {
        console.error('Check email registration error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error. Please try again later.',
            error: error.message
        });
    }
};