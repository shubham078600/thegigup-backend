import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../prisma.config.js';
import { uploadImage, deleteImage } from '../utils/cloudinary.js';
import { setCache, getCache, deleteCache } from '../utils/redis.js';
import { 
    generateOTP, 
    storeOTP, 
    verifyOTP, 
    isOTPVerified,
    invalidateOTP, 
    sendOTPEmail 
} from '../utils/passwordReset.js';
import transporter from '../nodemailer.config.js';

// Helper function to generate JWT token
const generateToken = (userId, role) => {
    return jwt.sign(
        { userId, role },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
    );
};

// Helper function to validate email
const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

// POST /api/freelancer/signup
export const signup = async (req, res) => {
    try {
        const {
            name,
            email,
            password,
            age,
            skills,
            experience,
            hourlyRate,
            githubUrl,
            linkedinUrl,
            portfolioUrl,
            bio,
            location
        } = req.body;

        // Validation
        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Name, email, and password are required'
            });
        }

        if (!isValidEmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid email address'
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 6 characters long'
            });
        }

        // Check if user already exists
        const existingUser = await prisma.user.findUnique({
            where: { email }
        });

        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'User with this email already exists'
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        // Handle profile image upload if provided
        let profileImageUrl = null;
        if (req.file) {
            const uploadResult = await uploadImage(req.file.buffer, 'freelancer-profiles');
            if (uploadResult.success) {
                profileImageUrl = uploadResult.url;
            }
        }

        // Create user and freelancer profile in a transaction
        const result = await prisma.$transaction(async (tx) => {
            // Create user
            const user = await tx.user.create({
                data: {
                    name,
                    email,
                    password: hashedPassword,
                    role: 'FREELANCER',
                    profileImage: profileImageUrl,
                    bio,
                    location
                }
            });

            // Create freelancer profile
            const freelancer = await tx.freelancer.create({
                data: {
                    userId: user.id,
                    age: age ? parseInt(age) : null,
                    skills: skills ? skills.split(',').map(skill => skill.trim()) : [],
                    experience,
                    hourlyRate: hourlyRate ? parseFloat(hourlyRate) : null,
                    githubUrl,
                    linkedinUrl,
                    portfolioUrl
                }
            });

            return { user, freelancer };
        });

        // Generate JWT token
        const token = generateToken(result.user.id, result.user.role);

        // Remove password from response
        const { password: _, ...userWithoutPassword } = result.user;

        res.status(201).json({
            success: true,
            message: 'Freelancer account created successfully',
            data: {
                user: userWithoutPassword,
                freelancer: result.freelancer,
                token
            }
        });

    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// POST /api/freelancer/login
export const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const cacheKey = `freelancer:login:${email}`;

        // Check cache
        const cachedUser = await getCache(cacheKey);
        if (cachedUser) {
            return res.status(200).json({
                success: true,
                message: 'Login successful',
                data: cachedUser
            });
        }

        // Fetch user from database
        const user = await prisma.user.findUnique({
            where: { email },
            include: {
                freelancer: true
            }
        });

        if (!user || user.role !== 'FREELANCER') {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials or not a freelancer account'
            });
        }

        // Check password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Generate JWT token
        const token = generateToken(user.id, user.role);

        const responseData = {
            user: { ...user, password: undefined },
            token
        };

        // Cache the login data
        await setCache(cacheKey, responseData, 600); // Cache for 10 minutes

        res.status(200).json({
            success: true,
            message: 'Login successful',
            data: responseData
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// PUT /api/freelancer/profile
export const updateProfile = async (req, res) => {
    try {
        const userId = req.user.userId; // From auth middleware
        const {
            name,
            bio,
            location,
            age,
            skills,
            experience,
            hourlyRate,
            availability,
            githubUrl,
            linkedinUrl,
            portfolioUrl
        } = req.body;

        // Check if user exists and is a freelancer
        const existingUser = await prisma.user.findUnique({
            where: { id: userId },
            include: { freelancer: true }
        });

        if (!existingUser || existingUser.role !== 'FREELANCER') {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
            });
        }

        // Handle profile image upload if provided
        let profileImageUrl = existingUser.profileImage;
        if (req.file) {
            // Delete old image if it exists
            if (existingUser.profileImage) {
                // Extract public_id from Cloudinary URL and delete
                const publicId = existingUser.profileImage.split('/').slice(-2).join('/').split('.')[0];
                await deleteImage(publicId);
            }

            const uploadResult = await uploadImage(req.file.buffer, 'freelancer-profiles');
            if (uploadResult.success) {
                profileImageUrl = uploadResult.url;
            }
        }

        // Update user and freelancer profile in a transaction
        const result = await prisma.$transaction(async (tx) => {
            // Update user
            const updatedUser = await tx.user.update({
                where: { id: userId },
                data: {
                    ...(name && { name }),
                    ...(bio !== undefined && { bio }),
                    ...(location !== undefined && { location }),
                    ...(profileImageUrl && { profileImage: profileImageUrl })
                }
            });

            // Update freelancer profile
            const updatedFreelancer = await tx.freelancer.update({
                where: { userId },
                data: {
                    ...(age && { age: parseInt(age) }),
                    ...(skills && { skills: skills.split(',').map(skill => skill.trim()) }),
                    ...(experience !== undefined && { experience }),
                    ...(hourlyRate && { hourlyRate: parseFloat(hourlyRate) }),
                    ...(availability !== undefined && { availability: Boolean(availability) }),
                    ...(githubUrl !== undefined && { githubUrl }),
                    ...(linkedinUrl !== undefined && { linkedinUrl }),
                    ...(portfolioUrl !== undefined && { portfolioUrl })
                }
            });

            return { user: updatedUser, freelancer: updatedFreelancer };
        });

        // Remove password from response
        const { password: _, ...userWithoutPassword } = result.user;

        res.status(200).json({
            success: true,
            message: 'Profile updated successfully',
            data: {
                user: userWithoutPassword,
                freelancer: result.freelancer
            }
        });

    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// GET /api/freelancer/profile
export const getProfile = async (req, res) => {
    try {
        const userId = req.user.userId; // From auth middleware

        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: {
                freelancer: {
                    include: {
                        assignedProjects: {
                            include: {
                                client: {
                                    include: {
                                        user: {
                                            select: {
                                                name: true,
                                                email: true,
                                                profileImage: true
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        if (!user || user.role !== 'FREELANCER') {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
            });
        }

        // Remove password from response
        const { password: _, ...userWithoutPassword } = user;

        res.status(200).json({
            success: true,
            data: userWithoutPassword
        });

    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// PUT /api/freelancer/availability
export const updateAvailability = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { availability } = req.body;

        if (availability === undefined) {
            return res.status(400).json({
                success: false,
                message: 'Availability status is required'
            });
        }

        const updatedFreelancer = await prisma.freelancer.update({
            where: { userId },
            data: { availability: Boolean(availability) }
        });

        res.status(200).json({
            success: true,
            message: 'Availability updated successfully',
            data: { availability: updatedFreelancer.availability }
        });

    } catch (error) {
        console.error('Update availability error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// POST /api/freelancer/forgot-password - Send OTP
export const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;

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

        // Check if user exists and is a freelancer
        const user = await prisma.user.findUnique({
            where: { email },
            include: { freelancer: true }
        });

        if (!user || user.role !== 'FREELANCER') {
            // For security, don't reveal if email exists
            return res.status(200).json({
                success: true,
                message: 'If a freelancer account with this email exists, you will receive an OTP shortly.'
            });
        }

        // Check if user account is active
        if (!user.isActive) {
            return res.status(400).json({
                success: false,
                message: 'Account is suspended. Please contact support.'
            });
        }

        // Check rate limiting (prevent spam)
        const rateLimitKey = `password_reset_rate_limit:FREELANCER:${email}`;
        const existingRequest = await getCache(rateLimitKey);
        
        if (existingRequest) {
            return res.status(429).json({
                success: false,
                message: 'OTP already sent. Please wait 2 minutes before requesting again.'
            });
        }

        // Generate OTP
        const otp = generateOTP();
        
        // Store OTP in Redis
        await storeOTP(email, otp, 'FREELANCER');
        
        // Set rate limiting (2 minutes)
        await setCache(rateLimitKey, true, 120);

        // Send OTP email
        await sendOTPEmail(email, user.name, otp, 'Freelancer');

        res.status(200).json({
            success: true,
            message: 'If a freelancer account with this email exists, you will receive an OTP shortly.',
            data: {
                otpSent: true,
                expiresIn: '10 minutes'
            }
        });

    } catch (error) {
        console.error('Freelancer forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error. Please try again later.',
            error: error.message
        });
    }
};

// POST /api/freelancer/verify-otp - Verify OTP and Reset Password
export const verifyOTPEndpoint = async (req, res) => {
    try {
        const { email, otp, newPassword, confirmPassword } = req.body;

        // Validation
        if (!email || !otp || !newPassword || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Email, OTP, new password, and confirm password are required'
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

        if (newPassword !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Passwords do not match'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 6 characters long'
            });
        }

        // Verify OTP
        const verification = await verifyOTP(email, otp, 'FREELANCER');
        
        if (!verification.valid) {
            return res.status(400).json({
                success: false,
                message: verification.error
            });
        }

        // Check if user exists and is a freelancer
        const user = await prisma.user.findUnique({
            where: { email },
            include: { freelancer: true }
        });

        if (!user || user.role !== 'FREELANCER') {
            return res.status(404).json({
                success: false,
                message: 'Freelancer account not found'
            });
        }

        // Check if user account is active
        if (!user.isActive) {
            return res.status(400).json({
                success: false,
                message: 'Account is suspended. Please contact support.'
            });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 12);

        // Update password in database
        await prisma.user.update({
            where: { id: user.id },
            data: { 
                password: hashedPassword,
                updatedAt: new Date()
            }
        });

        // Generate new JWT token
        const token = generateToken(user.id, user.role);

        // Invalidate OTP
        await invalidateOTP(email, 'FREELANCER');

        // Clear login cache
        await deleteCache(`freelancer:login:${email}`);

        // Send confirmation email
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Password Successfully Reset - FreeLanceAog',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background-color: #10B981; color: white; padding: 20px; text-align: center;">
                        <h1>✅ Password Reset Successful</h1>
                    </div>
                    <div style="padding: 30px; background-color: #f9f9f9;">
                        <h2>Hello ${user.name},</h2>
                        <p>Your freelancer account password has been successfully reset and you are now logged in.</p>
                        <div style="background-color: #FEF3C7; border-left: 4px solid #F59E0B; padding: 15px; margin: 20px 0;">
                            <strong>⚠️ Security Notice:</strong>
                            <p>If you did not make this change, please contact our support team immediately.</p>
                        </div>
                        <div style="background-color: #DBEAFE; border-left: 4px solid #3B82F6; padding: 15px; margin: 20px 0;">
                            <strong>🔐 Login Information:</strong>
                            <p>You have been automatically logged in with a new authentication token.</p>
                        </div>
                        <p>You can now access your account with the new password.</p>
                        <p>Best regards,<br>The FreeLanceAog Team</p>
                    </div>
                </div>
            `,
            text: `Hello ${user.name},\n\nYour freelancer account password has been successfully reset and you are now logged in.\n\nIf you did not make this change, please contact our support team immediately.\n\nBest regards,\nThe FreeLanceAog Team`
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error('Confirmation email error:', error);
            } else {
                console.log('Password reset confirmation sent:', info.response);
            }
        });

        // Remove password from user object for response
        const { password: _, ...userWithoutPassword } = user;

        res.status(200).json({
            success: true,
            message: 'OTP verified and password reset successfully. You are now logged in.',
            data: {
                verified: true,
                passwordReset: true,
                user: userWithoutPassword,
                token: token
            }
        });

    } catch (error) {
        console.error('Freelancer verify OTP and reset password error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error. Please try again later.',
            error: error.message
        });
    }
};