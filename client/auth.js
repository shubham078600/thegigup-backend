import { 
    generateOTP, 
    storeOTP, 
    verifyOTP, 
    isOTPVerified,
    invalidateOTP, 
    sendOTPEmail 
} from '../utils/passwordReset.js';
import { setCache, getCache, deleteCache } from '../utils/redis.js';
import transporter from '../nodemailer.config.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../prisma.config.js';
import { uploadImage, deleteImage } from '../utils/cloudinary.js';

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

// Helper function to invalidate client caches
const invalidateClientCaches = async (userId, clientId = null) => {
    const cacheKeysToDelete = [
        // Client specific caches
        `client:profile:${userId}`,
        `client:dashboard:${userId}`,
        
        // Public caches
        'public:projects:recent',
        'public:featured:clients',
        'admin:dashboard:stats'
    ];

    // Add project-related caches with different filters
    const statuses = ['all', 'OPEN', 'ASSIGNED', 'COMPLETED', 'PENDING_COMPLETION'];
    const pages = Array.from({length: 5}, (_, i) => i + 1);
    const limits = [10, 20, 50];

    for (const status of statuses) {
        for (const page of pages) {
            for (const limit of limits) {
                cacheKeysToDelete.push(
                    `client:projects:${userId}:status:${status}:page:${page}:limit:${limit}`,
                    `client:applications:${userId}:status:${status}:page:${page}:limit:${limit}`,
                    `client:meetings:${userId}:status:${status}:page:${page}:limit:${limit}`
                );
            }
        }
    }

    // Delete all caches
    await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));
};

// Calculate profile completeness
const calculateClientProfileCompleteness = (user, client) => {
    const fields = {
        name: user.name ? 10 : 0,
        bio: user.bio ? 15 : 0,
        profileImage: user.profileImage ? 10 : 0,
        location: user.location ? 5 : 0,
        phone: user.phone ? 10 : 0,
        website: user.website ? 5 : 0,
        companyName: client.companyName ? 10 : 0,
        companySize: client.companySize ? 5 : 0,
        industry: client.industry ? 10 : 0,
        companyWebsite: client.companyWebsite ? 5 : 0,
        preferredCategories: (client.preferredCategories && client.preferredCategories.length > 0) ? 10 : 0,
        budgetRange: client.budgetRange ? 5 : 0,
        communicationPreference: client.communicationPreference ? 5 : 0,
        timezone: user.timezone ? 5 : 0
    };

    const totalScore = Object.values(fields).reduce((sum, score) => sum + score, 0);
    const missingFields = Object.keys(fields).filter(field => fields[field] === 0);

    return {
        percentage: totalScore,
        missingFields,
        completedSections: totalScore >= 80 ? 
            ['personal_info', 'contact_info', 'company_info', 'preferences', 'profile_image'] : 
            []
    };
};

// POST /api/client/signup
export const signup = async (req, res) => {
    try {
        const {
            name,
            email,
            password,
            companyName,
            industry,
            website,
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
            const uploadResult = await uploadImage(req.file.buffer, 'client-profiles');
            if (uploadResult.success) {
                profileImageUrl = uploadResult.url;
            }
        }

        // Create user and client profile in a transaction
        const result = await prisma.$transaction(async (tx) => {
            // Create user
            const user = await tx.user.create({
                data: {
                    name,
                    email,
                    password: hashedPassword,
                    role: 'CLIENT',
                    profileImage: profileImageUrl,
                    bio,
                    location
                }
            });

            // Create client profile
            const client = await tx.client.create({
                data: {
                    userId: user.id,
                    companyName,
                    industry,
                    website
                }
            });

            return { user, client };
        });

        // Generate JWT token
        const token = generateToken(result.user.id, result.user.role);

        // Remove password from response
        const { password: _, ...userWithoutPassword } = result.user;

        res.status(201).json({
            success: true,
            message: 'Client account created successfully',
            data: {
                user: userWithoutPassword,
                client: result.client,
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

// POST /api/client/login
export const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const cacheKey = `client:login:${email}`;

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
                client: true
            }
        });

        if (!user || user.role !== 'CLIENT') {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials or not a client account'
            });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

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

// PUT /api/client/profile - Fixed profile image update issue
export const updateProfile = async (req, res) => {
    try {
        const userId = req.user.userId;
        console.log('Update profile request:', {
            userId,
            hasFile: !!req.file,
            body: req.body
        });

        // Check if user exists and is a client
        const existingUser = await prisma.user.findUnique({
            where: { id: userId },
            include: { client: true }
        });

        if (!existingUser || existingUser.role !== 'CLIENT') {
            return res.status(404).json({
                success: false,
                message: 'Client profile not found'
            });
        }

        // Handle profile image upload if provided
        let profileImageUrl = existingUser.profileImage;
        let imageUpdated = false;
        
        if (req.file) {
            try {
                // Delete old image if it exists
                if (existingUser.profileImage) {
                    const publicId = existingUser.profileImage.split('/').slice(-2).join('/').split('.')[0];
                    await deleteImage(publicId);
                }

                const uploadResult = await uploadImage(req.file.buffer, 'client-profiles');
                if (uploadResult.success) {
                    profileImageUrl = uploadResult.url;
                    imageUpdated = true;
                    console.log('Profile image uploaded successfully:', profileImageUrl);
                } else {
                    throw new Error('Failed to upload image to Cloudinary');
                }
            } catch (uploadError) {
                console.error('Image upload error:', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to upload profile image. Please try again.',
                    error: uploadError.message
                });
            }
        }

        // Extract fields from request body
        const {
            name,
            bio,
            location,
            companyName,
            industry,
            website
        } = req.body;

        // Validate that at least one field is provided (excluding email and phone)
        const hasUpdates = name || bio || location || companyName || industry || website || req.file;
        if (!hasUpdates) {
            return res.status(400).json({
                success: false,
                message: 'At least one field must be provided for update'
            });
        }

        // Update user and client profile in a transaction (similar to freelancer approach)
        const result = await prisma.$transaction(async (tx) => {
            // Update user table - FIXED: Include profileImage update
            const userUpdateData = {
                ...(name && { name }),
                ...(bio !== undefined && { bio }),
                ...(location !== undefined && { location }),
                ...(imageUpdated && { profileImage: profileImageUrl })
            };

            const updatedUser = await tx.user.update({
                where: { id: userId },
                data: userUpdateData,
                include: { client: true }
            });

            // Update client table
            const clientUpdateData = {
                ...(companyName !== undefined && { companyName }),
                ...(industry !== undefined && { industry }),
                ...(website !== undefined && { website })
            };

            const updatedClient = await tx.client.update({
                where: { userId },
                data: clientUpdateData
            });

            return { user: updatedUser, client: updatedClient };
        });

        // Invalidate all relevant caches
        await invalidateClientCaches(userId);

        // Remove password from response
        const { password: _, ...userWithoutPassword } = result.user;

        console.log('Profile update successful:', {
            updatedFields: Object.keys(req.body).concat(req.file ? ['profileImage'] : []),
            hasImageUpdate: imageUpdated,
            newImageUrl: imageUpdated ? profileImageUrl : 'No change'
        });

        res.status(200).json({
            success: true,
            message: 'Profile updated successfully',
            data: {
                user: userWithoutPassword,
                client: result.client,
                imageUpdated: imageUpdated,
                ...(imageUpdated && { newImageUrl: profileImageUrl })
            }
        });

    } catch (error) {
        console.error('Client profile update error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error. Please try again later.',
            error: error.message
        });
    }
};

// GET /api/client/profile
export const getProfile = async (req, res) => {
    try {
        const userId = req.user.userId; // From auth middleware

        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: {
                client: {
                    include: {
                        projects: {
                            include: {
                                freelancer: {
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
                            },
                            orderBy: {
                                createdAt: 'desc'
                            }
                        }
                    }
                }
            }
        });

        if (!user || user.role !== 'CLIENT') {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
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

// GET /api/client/freelancers
export const getAllFreelancers = async (req, res) => {
    try {
        const {
            skills,
            minRating,
            location,
            availability,
            page = 1,
            limit = 10
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const whereClause = {};

        // Filter by availability
        if (availability !== undefined) {
            whereClause.availability = availability === 'true';
        }

        // Filter by minimum rating
        if (minRating) {
            whereClause.ratings = { gte: parseFloat(minRating) };
        }

        // Filter by skills
        if (skills) {
            const skillsArray = skills.split(',').map(skill => skill.trim());
            whereClause.skills = {
                hasSome: skillsArray
            };
        }

        // User location filter
        const userWhereClause = {};
        if (location) {
            userWhereClause.location = {
                contains: location,
                mode: 'insensitive'
            };
        }

        const freelancers = await prisma.freelancer.findMany({

            ...(whereClause.length != 0 && { where: whereClause }),
            include: {
                user: {
                    select: {
                        name: true,
                        email: true,
                        profileImage: true,
                        bio: true,
                        location: true,
                        createdAt: true
                    }
                }
            },
            orderBy: {
                ratings: 'desc'
            },
            skip,
            take: parseInt(limit)
        });

        // Filter out freelancers whose users don't match location criteria
        const filteredFreelancers = freelancers.filter(freelancer => freelancer.user);

        const totalFreelancers = await prisma.freelancer.count({
            where: whereClause,
            ...(location && {
                include: {
                    user: {
                        where: userWhereClause
                    }
                }
            })
        });

        res.status(200).json({
            success: true,
            data: {
                freelancers: filteredFreelancers,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: totalFreelancers,
                    pages: Math.ceil(totalFreelancers / parseInt(limit))
                }
            }
        });

    } catch (error) {
        console.error('Get freelancers error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// POST /api/client/forgot-password - Send OTP
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

        // Check if user exists and is a client
        const user = await prisma.user.findUnique({
            where: { email },
            include: { client: true }
        });

        if (!user || user.role !== 'CLIENT') {
            return res.status(200).json({
                success: true,
                message: 'If a client account with this email exists, you will receive an OTP shortly.'
            });
        }

        if (!user.isActive) {
            return res.status(400).json({
                success: false,
                message: 'Account is suspended. Please contact support.'
            });
        }

        // Check rate limiting
        const rateLimitKey = `password_reset_rate_limit:CLIENT:${email}`;
        const existingRequest = await getCache(rateLimitKey);
        
        if (existingRequest) {
            return res.status(429).json({
                success: false,
                message: 'OTP already sent. Please wait 2 minutes before requesting again.'
            });
        }

        // Generate and store OTP
        const otp = generateOTP();
        await storeOTP(email, otp, 'CLIENT');
        await setCache(rateLimitKey, true, 120);

        // Send OTP email
        await sendOTPEmail(email, user.name, otp, 'Client');

        res.status(200).json({
            success: true,
            message: 'If a client account with this email exists, you will receive an OTP shortly.',
            data: {
                otpSent: true,
                expiresIn: '10 minutes'
            }
        });

    } catch (error) {
        console.error('Client forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error. Please try again later.',
            error: error.message
        });
    }
};

// POST /api/client/verify-otp - Verify OTP and Reset Password
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
        const verification = await verifyOTP(email, otp, 'CLIENT');
        
        if (!verification.valid) {
            return res.status(400).json({
                success: false,
                message: verification.error
            });
        }

        // Check if user exists and is a client
        const user = await prisma.user.findUnique({
            where: { email },
            include: { client: true }
        });

        if (!user || user.role !== 'CLIENT') {
            return res.status(404).json({
                success: false,
                message: 'Client account not found'
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
        await invalidateOTP(email, 'CLIENT');

        // Clear login cache
        await deleteCache(`client:login:${email}`);

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
                        <p>Your client account password has been successfully reset and you are now logged in.</p>
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
            text: `Hello ${user.name},\n\nYour client account password has been successfully reset and you are now logged in.\n\nBest regards,\nThe FreeLanceAog Team`
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
        console.error('Client verify OTP and reset password error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error. Please try again later.',
            error: error.message
        });
    }
};

// Helper function to validate individual fields
const validateClientField = (fieldName, value) => {
    const errors = [];

    switch (fieldName) {
        case 'name':
            if (value && (typeof value !== 'string' || value.length < 2 || value.length > 100)) {
                errors.push({ field: 'name', message: 'Name must be between 2 and 100 characters' });
            }
            break;

        case 'bio':
            if (value && (typeof value !== 'string' || value.length > 500)) {
                errors.push({ field: 'bio', message: 'Bio must be less than 500 characters' });
            }
            break;

        case 'email':
            if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
                errors.push({ field: 'email', message: 'Please provide a valid email address' });
            }
            break;

        case 'phone':
            if (value && !/^[\+]?[\s\-\(\)]*(\d[\s\-\(\)]*){10,14}$/.test(value)) {
                errors.push({ field: 'phone', message: 'Please provide a valid phone number' });
            }
            break;

        case 'profileImage':
        case 'website':
        case 'companyWebsite':
            if (value && !/^https?:\/\/.+\..+/.test(value)) {
                errors.push({ field: fieldName, message: `Please provide a valid URL for ${fieldName}` });
            }
            break;

        case 'location':
            if (value && (typeof value !== 'string' || value.length > 100)) {
                errors.push({ field: 'location', message: 'Location must be less than 100 characters' });
            }
            break;

        case 'companyName':
            if (value && (typeof value !== 'string' || value.length > 100)) {
                errors.push({ field: 'companyName', message: 'Company name must be less than 100 characters' });
            }
            break;

        case 'industry':
            if (value && (typeof value !== 'string' || value.length > 50)) {
                errors.push({ field: 'industry', message: 'Industry must be less than 50 characters' });
            }
            break;

        case 'companySize':
            const validSizes = ['1-10', '11-50', '51-200', '201-500', '500+'];
            if (value && !validSizes.includes(value)) {
                errors.push({ field: 'companySize', message: 'Invalid company size' });
            }
            break;

        case 'communicationPreference':
            const validPrefs = ['email', 'phone', 'chat', 'video_call'];
            if (value && !validPrefs.includes(value)) {
                errors.push({ field: 'communicationPreference', message: 'Invalid communication preference' });
            }
            break;

        case 'preferredCategories':
            if (value && (!Array.isArray(value) || value.some(cat => typeof cat !== 'string'))) {
                errors.push({ field: 'preferredCategories', message: 'Preferred categories must be an array of strings' });
            }
            break;

        case 'projectNotifications':
        case 'emailNotifications':
        case 'marketingEmails':
            if (value !== undefined && typeof value !== 'boolean') {
                errors.push({ field: fieldName, message: `${fieldName} must be a boolean value` });
            }
            break;
    }

    return errors;
};