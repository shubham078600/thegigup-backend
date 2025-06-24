import { Router } from "express";
import multer from "multer";

import prisma from "../prisma.config.js";
import {
    signup,
    login,
    updateProfile,
    getProfile,
    getAllFreelancers,
    forgotPassword,
    verifyOTPEndpoint,
} from "./auth.js";
import { authenticateToken, checkClientActive } from "../middleware/auth.js";
import { setCache, getCache, deleteCache } from "../utils/redis.js";

export const clientRouter = Router();

// Configure multer for file uploads (profile images)
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// Add this helper function at the top of your client.js file

const invalidateClientCaches = async (userId, clientId = null) => {
    const cacheKeysToDelete = [
        // Client specific caches
        `client:profile:${userId}`,
        `client:dashboard:${userId}`,
        
        // Public caches
        'public:projects:available',
        'public:projects:recent',
        'public:featured:projects',
        'admin:dashboard:stats'
    ];

    // Add project-related caches with different filters
    const statuses = ['all', 'OPEN', 'ASSIGNED', 'COMPLETED'];
    const pages = Array.from({length: 5}, (_, i) => i + 1);
    const limits = [10, 20, 50];

    for (const status of statuses) {
        for (const page of pages) {
            for (const limit of limits) {
                cacheKeysToDelete.push(
                    `client:projects:${userId}:status:${status}:page:${page}:limit:${limit}`
                );
            }
        }
    }

    // Delete all caches
    await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));
};

// Authentication Routes (Public)
clientRouter.post('/signup', upload.single('profileImage'), signup);
clientRouter.post('/login', login);
clientRouter.post('/forgot-password', forgotPassword);
clientRouter.post('/verify-otp', verifyOTPEndpoint);

// Profile Management Routes (Protected)
clientRouter.get('/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const cacheKey = `client:profile:${userId}`;

        // Check cache
        const cachedProfile = await getCache(cacheKey);
        if (cachedProfile) {
            return res.status(200).json({
                success: true,
                data: cachedProfile
            });
        }

        // Fetch profile from database
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: {
                client: {
                    include: {
                        projects: true
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

        // Cache the profile
        await setCache(cacheKey, user, 600); // Cache for 10 minutes

        res.status(200).json({
            success: true,
            data: user
        });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

clientRouter.put('/profile', authenticateToken, upload.single('profileImage'), async (req, res) => {
    try {
        const userId = req.user.userId;

        // Call the updateProfile function from auth.js
        await updateProfile(req, res);

        // Invalidate profile cache
        const cacheKey = `client:profile:${userId}`;
        await deleteCache(cacheKey);

    } catch (error) {
        console.error('Update profile error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: 'Internal server error',
                error: error.message
            });
        }
    }
});

// Freelancer Management Routes (Protected)
clientRouter.get('/freelancers', authenticateToken, getAllFreelancers);

// Project Management Routes (Protected)
// POST /api/client/projects - Create a new project
clientRouter.post('/projects', authenticateToken, checkClientActive, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            title,
            description,
            skillsRequired,
            budgetMin,
            budgetMax,
            duration
        } = req.body;

        // Validation
        if (!title) {
            return res.status(400).json({
                success: false,
                message: 'Project title is required'
            });
        }

        // Check if user is a client
        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Create project
        const project = await prisma.project.create({
            data: {
                title,
                description,
                clientId: client.id,
                skillsRequired: skillsRequired ? skillsRequired.split(',').map(skill => skill.trim()) : [],
                budgetMin: budgetMin ? parseFloat(budgetMin) : null,
                budgetMax: budgetMax ? parseFloat(budgetMax) : null,
                duration
            },
            include: {
                client: {
                    include: {
                        user: {
                            select: {
                                name: true,
                                profileImage: true
                            }
                        }
                    }
                }
            }
        });

        // Update client's projects posted count
        await prisma.client.update({
            where: { id: client.id },
            data: {
                projectsPosted: {
                    increment: 1
                }
            }
        });

        // COMPREHENSIVE CACHE INVALIDATION - Add this section
        const cacheKeysToDelete = [
            // Client specific caches
            `client:profile:${userId}`,
            `client:dashboard:${userId}`,
            `client:projects:${userId}`,
            
            // Public caches that might show this project
            `public:projects:available`,
            `public:projects:recent`,
            `public:featured:projects`,
            
            // Admin dashboard cache
            `admin:dashboard:stats`,
            
            // Any cached project lists with pagination
            ...Array.from({length: 10}, (_, i) => `client:projects:${userId}:page:${i + 1}`),
            ...Array.from({length: 10}, (_, i) => `public:projects:page:${i + 1}`),
        ];

        // Delete all relevant caches
        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        // Also invalidate pattern-based caches (if you have wildcard deletion)
        try {
            // Delete all project-related caches for this client
            await deleteCache(`client:projects:${userId}:*`);
            await deleteCache(`public:projects:*`);
        } catch (error) {
            console.log('Pattern cache deletion not supported, using individual deletion');
        }

        res.status(201).json({
            success: true,
            message: 'Project created successfully',
            data: project
        });

    } catch (error) {
        console.error('Create project error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/client/projects - Get client's posted projects
clientRouter.get('/projects', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { status, page = 1, limit = 10 } = req.query;
        
        // Create cache key based on query parameters
        const cacheKey = `client:projects:${userId}:status:${status || 'all'}:page:${page}:limit:${limit}`;
        
        // Check cache first (shorter duration)
        const cachedProjects = await getCache(cacheKey);
        if (cachedProjects) {
            return res.status(200).json({
                success: true,
                data: cachedProjects,
                cached: true
            });
        }
        
        const skip = (parseInt(page) - 1) * parseInt(limit);
        
        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        const whereClause = {
            clientId: client.id
        };

        if (status) {
            whereClause.status = status.toUpperCase();
        }

        const [projects, totalProjects] = await Promise.all([
            prisma.project.findMany({
                where: whereClause,
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
                    },
                    applications: {
                        where: {
                            status: 'PENDING'
                        },
                        select: {
                            id: true,
                            status: true,
                            createdAt: true,
                            freelancer: {
                                select: {
                                    user: {
                                        select: {
                                            name: true,
                                            profileImage: true
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                orderBy: {
                    createdAt: 'desc'
                },
                skip,
                take: parseInt(limit)
            }),
            prisma.project.count({
                where: whereClause
            })
        ]);

        const responseData = {
            projects,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalProjects,
                pages: Math.ceil(totalProjects / parseInt(limit))
            }
        };

        // Cache for shorter duration (3 minutes)
        await setCache(cacheKey, responseData, 180);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get projects error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/client/projects/:projectId/applications - Get all applications for a specific project
clientRouter.get('/projects/:projectId/applications', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId } = req.params;
        const { status, page = 1, limit = 10 } = req.query;

        // Create cache key
        const cacheKey = `client:project:${projectId}:applications:status:${status || 'all'}:page:${page}:limit:${limit}`;

        // Check cache first (shorter duration for real-time updates)
        const cachedApplications = await getCache(cacheKey);
        if (cachedApplications) {
            return res.status(200).json({
                success: true,
                data: cachedApplications,
                cached: true
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Check if user is a client
        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Check if project belongs to this client
        const project = await prisma.project.findFirst({
            where: {
                id: projectId,
                clientId: client.id
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found or you do not have permission to view it'
            });
        }

        const whereClause = {
            projectId
        };

        if (status) {
            whereClause.status = status.toUpperCase();
        }

        const [applications, totalApplications] = await Promise.all([
            prisma.application.findMany({
                where: whereClause,
                include: {
                    freelancer: {
                        include: {
                            user: {
                                select: {
                                    name: true,
                                    email: true,
                                    profileImage: true,
                                    bio: true,
                                    location: true
                                }
                            }
                        }
                    },
                    project: {
                        select: {
                            title: true,
                            description: true,
                            skillsRequired: true,
                            budgetMin: true,
                            budgetMax: true
                        }
                    }
                },
                orderBy: {
                    createdAt: 'desc'
                },
                skip,
                take: parseInt(limit)
            }),
            prisma.application.count({
                where: whereClause
            })
        ]);

        const responseData = {
            applications,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalApplications,
                pages: Math.ceil(totalApplications / parseInt(limit))
            }
        };

        // Cache for 2 minutes (short duration for real-time updates)
        await setCache(cacheKey, responseData, 120);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get project applications error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// PUT /api/client/projects/:projectId/applications/:applicationId/reject - Reject an application
clientRouter.put('/projects/:projectId/applications/:applicationId/reject', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId, applicationId } = req.params;

        // Check if user is a client
        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Check if project belongs to this client
        const project = await prisma.project.findFirst({
            where: {
                id: projectId,
                clientId: client.id
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found or you do not have permission to modify it'
            });
        }

        // Check if application exists and belongs to this project
        const application = await prisma.application.findFirst({
            where: {
                id: applicationId,
                projectId
            },
            include: {
                freelancer: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                profileImage: true
                            }
                        }
                    }
                }
            }
        });

        if (!application) {
            return res.status(404).json({
                success: false,
                message: 'Application not found'
            });
        }

        if (application.status !== 'PENDING') {
            return res.status(400).json({
                success: false,
                message: 'Application has already been processed'
            });
        }

        // Reject the application
        const rejectedApplication = await prisma.application.update({
            where: { id: applicationId },
            data: { status: 'REJECTED' },
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
            }
        });

        // COMPREHENSIVE CACHE INVALIDATION FOR APPLICATION REJECTION
        const freelancerUserId = application.freelancer.user.id;
        const cacheKeysToDelete = [
            // Client caches
            `client:dashboard:${userId}`,
            
            // Freelancer caches (application rejected)
            `freelancer:dashboard:${freelancerUserId}`,
            
            // Admin dashboard
            'admin:dashboard:stats'
        ];

        // Add paginated caches for both client and freelancer
        for (let page = 1; page <= 10; page++) {
            for (let limit of [10, 20, 50]) {
                // Client caches
                cacheKeysToDelete.push(
                    `client:applications:${userId}:status:all:page:${page}:limit:${limit}`,
                    `client:applications:${userId}:status:PENDING:page:${page}:limit:${limit}`,
                    `client:applications:${userId}:status:REJECTED:page:${page}:limit:${limit}`,
                    
                    // Project-specific application caches
                    `client:project:${projectId}:applications:status:all:page:${page}:limit:${limit}`,
                    `client:project:${projectId}:applications:status:PENDING:page:${page}:limit:${limit}`,
                    `client:project:${projectId}:applications:status:REJECTED:page:${page}:limit:${limit}`
                );
                
                // Freelancer caches
                cacheKeysToDelete.push(
                    `freelancer:applications:${freelancerUserId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:applications:${freelancerUserId}:status:PENDING:page:${page}:limit:${limit}`,
                    `freelancer:applications:${freelancerUserId}:status:REJECTED:page:${page}:limit:${limit}`
                );
            }
        }

        // Execute cache deletion
        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(200).json({
            success: true,
            message: 'Application rejected successfully',
            data: rejectedApplication
        });

    } catch (error) {
        console.error('Reject application error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/client/applications - Get all applications for all projects
clientRouter.get('/applications', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { status, page = 1, limit = 10 } = req.query;

        // ADD THIS MISSING LINE
        const cacheKey = `client:applications:${userId}:status:${status || 'all'}:page:${page}:limit:${limit}`;

        // Check cache first (shorter duration for real-time updates)
        const cachedApplications = await getCache(cacheKey);
        if (cachedApplications) {
            return res.status(200).json({
                success: true,
                data: cachedApplications,
                cached: true
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Check if user is a client
        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        const whereClause = {
            project: {
                clientId: client.id
            }
        };

        if (status) {
            whereClause.status = status.toUpperCase();
        }

        const applications = await prisma.application.findMany({
            where: whereClause,
            include: {
                freelancer: {
                    include: {
                        user: {
                            select: {
                                name: true,
                                email: true,
                                profileImage: true,
                                bio: true,
                                location: true
                            }
                        }
                    }
                },
                project: {
                    select: {
                        id: true,
                        title: true,
                        description: true,
                        skillsRequired: true,
                        budgetMin: true,
                        budgetMax: true,
                        status: true
                    }
                }
            },
            orderBy: {
                createdAt: 'desc'
            },
            skip,
            take: parseInt(limit)
        });

        const totalApplications = await prisma.application.count({
            where: whereClause
        });

        // Group applications by project
        const groupedApplications = applications.reduce((acc, app) => {
            const projectId = app.project.id;
            if (!acc[projectId]) {
                acc[projectId] = {
                    project: app.project,
                    applications: []
                };
            }
            acc[projectId].applications.push(app);
            return acc;
        }, {});

        const responseData = {
            applications,
            groupedApplications: Object.values(groupedApplications),
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalApplications,
                pages: Math.ceil(totalApplications / parseInt(limit))
            }
        };

        // Cache for 2 minutes (short duration for real-time updates)
        await setCache(cacheKey, responseData, 120);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get all applications error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/client/dashboard - Get client dashboard data
clientRouter.get('/dashboard', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const cacheKey = `client:dashboard:${userId}`;

        // Check cache with shorter duration
        const cachedDashboard = await getCache(cacheKey);
        if (cachedDashboard) {
            return res.status(200).json({
                success: true,
                data: cachedDashboard,
                cached: true
            });
        }

        // Fetch dashboard data from database
        const client = await prisma.client.findUnique({
            where: { userId },
            include: {
                projects: {
                    include: {
                        applications: {
                            where: {
                                status: 'PENDING'
                            }
                        },
                        freelancer: {
                            select: {
                                user: {
                                    select: {
                                        name: true,
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
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        const stats = {
            totalProjects: client.projectsPosted,
            openProjects: client.projects.filter(p => p.status === 'OPEN').length,
            assignedProjects: client.projects.filter(p => p.status === 'ASSIGNED').length,
            completedProjects: client.projects.filter(p => p.status === 'COMPLETED').length,
            pendingApplications: client.projects.reduce((sum, project) => sum + project.applications.length, 0)
        };

        const dashboardData = { 
            client, 
            stats,
            recentProjects: client.projects.slice(0, 5) // Show 5 most recent projects
        };

        // Cache for shorter duration (2 minutes instead of 5)
        await setCache(cacheKey, dashboardData, 120);

        res.status(200).json({
            success: true,
            data: dashboardData
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// PUT /api/client/projects/:projectId/approve-completion - Approve project completion
clientRouter.put('/projects/:projectId/approve-completion', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId } = req.params;
        const { feedback, rating } = req.body; // Optional: client feedback and rating

        // Check if client exists
        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Check if project belongs to this client and is pending completion
        const project = await prisma.project.findFirst({
            where: {
                id: projectId,
                clientId: client.id,
                status: 'PENDING_COMPLETION'
            },
            include: {
                freelancer: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true
                            }
                        }
                    }
                }
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found or not pending completion'
            });
        }

        // Update project status to COMPLETED and increment freelancer's completed projects
        const updatedProject = await prisma.$transaction(async (tx) => {
            // Update project status
            const completedProject = await tx.project.update({
                where: { id: projectId },
                data: { 
                    status: 'COMPLETED',
                    updatedAt: new Date()
                }
            });

            // Update freelancer's completed projects count
            await tx.freelancer.update({
                where: { id: project.assignedTo },
                data: {
                    projectsCompleted: {
                        increment: 1
                    }
                }
            });

            return completedProject;
        });

        // COMPREHENSIVE CACHE INVALIDATION FOR PROJECT COMPLETION
        const freelancerUserId = project.freelancer.user.id;
        const cacheKeysToDelete = [
            // Client caches
            `client:dashboard:${userId}`,
            `client:profile:${userId}`,
            
            // Freelancer caches (project completed, stats updated)
            `freelancer:dashboard:${freelancerUserId}`,
            `freelancer:profile:${freelancerUserId}`,
            
            // Public caches (freelancer stats might affect featured list)
            'public:featured:freelancers',
            'admin:dashboard:stats'
        ];

        // Add paginated caches for both client and freelancer
        for (let page = 1; page <= 10; page++) {
            for (let limit of [10, 20, 50]) {
                // Client project caches
                cacheKeysToDelete.push(
                    `client:projects:${userId}:status:all:page:${page}:limit:${limit}`,
                    `client:projects:${userId}:status:PENDING_COMPLETION:page:${page}:limit:${limit}`,
                    `client:projects:${userId}:status:COMPLETED:page:${page}:limit:${limit}`,
                    `client:projects:${userId}:status:ASSIGNED:page:${page}:limit:${limit}`
                );
                
                // Freelancer project caches
                cacheKeysToDelete.push(
                    `freelancer:projects:${freelancerUserId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:projects:${freelancerUserId}:status:PENDING_COMPLETION:page:${page}:limit:${limit}`,
                    `freelancer:projects:${freelancerUserId}:status:COMPLETED:page:${page}:limit:${limit}`,
                    `freelancer:projects:${freelancerUserId}:status:ASSIGNED:page:${page}:limit:${limit}`
                );
            }
        }

        // Execute cache deletion
        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(200).json({
            success: true,
            message: 'Project completion approved successfully.',
            data: updatedProject
        });

    } catch (error) {
        console.error('Approve project completion error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// PUT /api/client/projects/:projectId/reject-completion - Reject project completion
clientRouter.put('/projects/:projectId/reject-completion', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId } = req.params;
        const { rejectionReason } = req.body; // Required: reason for rejection

        if (!rejectionReason) {
            return res.status(400).json({
                success: false,
                message: 'Rejection reason is required'
            });
        }

        // Check if client exists
        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Check if project belongs to this client and is pending completion
        const project = await prisma.project.findFirst({
            where: {
                id: projectId,
                clientId: client.id,
                status: 'PENDING_COMPLETION'
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found or not pending completion'
            });
        }

        // Update project status back to ASSIGNED
        const updatedProject = await prisma.project.update({
            where: { id: projectId },
            data: { 
                status: 'ASSIGNED',
                updatedAt: new Date()
            }
        });

        // COMPREHENSIVE CACHE INVALIDATION FOR COMPLETION REJECTION
        const freelancerUserId = project.freelancer.user.id;
        const cacheKeysToDelete = [
            // Client caches
            `client:dashboard:${userId}`,
            
            // Freelancer caches (project status reverted)
            `freelancer:dashboard:${freelancerUserId}`,
            
            // Admin dashboard
            'admin:dashboard:stats'
        ];

        // Add paginated caches for both client and freelancer
        for (let page = 1; page <= 10; page++) {
            for (let limit of [10, 20, 50]) {
                // Client project caches
                cacheKeysToDelete.push(
                    `client:projects:${userId}:status:all:page:${page}:limit:${limit}`,
                    `client:projects:${userId}:status:PENDING_COMPLETION:page:${page}:limit:${limit}`,
                    `client:projects:${userId}:status:ASSIGNED:page:${page}:limit:${limit}`
                );
                
                // Freelancer project caches
                cacheKeysToDelete.push(
                    `freelancer:projects:${freelancerUserId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:projects:${freelancerUserId}:status:PENDING_COMPLETION:page:${page}:limit:${limit}`,
                    `freelancer:projects:${freelancerUserId}:status:ASSIGNED:page:${page}:limit:${limit}`
                );
            }
        }

        // Execute cache deletion
        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(200).json({
            success: true,
            message: 'Project completion request rejected. Freelancer has been notified.',
            data: {
                project: updatedProject,
                rejectionReason
            }
        });

    } catch (error) {
        console.error('Reject project completion error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// POST /api/client/projects/:projectId/rate-freelancer - Rate a freelancer after project completion
clientRouter.post('/projects/:projectId/rate-freelancer', authenticateToken, checkClientActive, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId } = req.params;
        const { rating, review } = req.body;

        // Validation
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({
                success: false,
                message: 'Rating must be between 1 and 5 stars'
            });
        }

        // Use client from middleware
        const client = req.client;

        // Check if project exists, is completed, and belongs to this client
        const project = await prisma.project.findFirst({
            where: {
                id: projectId,
                clientId: client.id,
                status: 'COMPLETED'
            },
            include: {
                freelancer: {
                    include: {
                        user: true
                    }
                }
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found, not completed, or does not belong to you'
            });
        }

        if (!project.freelancer) {
            return res.status(400).json({
                success: false,
                message: 'No freelancer assigned to this project'
            });
        }

        // Check if client has already rated this freelancer for this project
        const existingRating = await prisma.rating.findUnique({
            where: {
                projectId_raterId_ratedId: {
                    projectId,
                    raterId: userId,
                    ratedId: project.freelancer.userId
                }
            }
        });

        if (existingRating) {
            return res.status(400).json({
                success: false,
                message: 'You have already rated this freelancer for this project'
            });
        }

        // Create rating in transaction to update freelancer's average rating
        const result = await prisma.$transaction(async (tx) => {
            // Create the rating
            const newRating = await tx.rating.create({
                data: {
                    projectId,
                    raterId: userId,
                    ratedId: project.freelancer.userId,
                    raterType: 'CLIENT_TO_FREELANCER',
                    rating: parseInt(rating),
                    review
                },
                include: {
                    project: {
                        select: {
                            title: true
                        }
                    }
                }
            });

            // Calculate new average rating for the freelancer
            const freelancerRatings = await tx.rating.findMany({
                where: {
                    ratedId: project.freelancer.userId,
                    raterType: 'CLIENT_TO_FREELANCER'
                },
                select: {
                    rating: true
                }
            });

            const averageRating = freelancerRatings.reduce((sum, r) => sum + r.rating, 0) / freelancerRatings.length;

            // Update freelancer's average rating
            await tx.freelancer.update({
                where: { id: project.assignedTo },
                data: {
                    ratings: parseFloat(averageRating.toFixed(2))
                }
            });

            return newRating;
        });

        // Invalidate relevant caches
        await deleteCache(`freelancer:profile:${project.freelancer.userId}`);
        await deleteCache(`public:featured:freelancers`);

        res.status(201).json({
            success: true,
            message: 'Freelancer rated successfully',
            data: result
        });

    } catch (error) {
        console.error('Rate freelancer error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/client/ratings - Get all ratings given and received by client
clientRouter.get('/ratings', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { type = 'all', page = 1, limit = 10 } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const client = await prisma.client.findUnique({
            where: { userId },
            select: { id: true }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        let whereClause = {};

        if (type === 'given') {
            // Ratings given by this client to freelancers
            whereClause = {
                raterId: userId,
                raterType: 'CLIENT_TO_FREELANCER'
            };
        } else if (type === 'received') {
            // Ratings received by this client from freelancers
            whereClause = {
                ratedId: userId,
                raterType: 'FREELANCER_TO_CLIENT'
            };
        } else {
            // All ratings (given and received)
            whereClause = {
                OR: [
                    { raterId: userId },
                    { ratedId: userId }
                ]
            };
        }

        const [ratings, totalRatings] = await Promise.all([
            prisma.rating.findMany({
                where: whereClause,
                include: {
                    project: {
                        select: {
                            title: true,
                            client: {
                                include: {
                                    user: {
                                        select: {
                                            name: true,
                                            profileImage: true
                                        }
                                    }
                                }
                            },
                            freelancer: {
                                include: {
                                    user: {
                                        select: {
                                            name: true,
                                            profileImage: true
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                orderBy: {
                    createdAt: 'desc'
                },
                skip,
                take: parseInt(limit)
            }),
            prisma.rating.count({ where: whereClause })
        ]);

        // Format the response
        const formattedRatings = ratings.map(rating => ({
            id: rating.id,
            rating: rating.rating,
            review: rating.review,
            type: rating.raterType,
            isGivenByMe: rating.raterId === userId,
            project: {
                title: rating.project.title
            },
            otherParty: rating.raterId === userId 
                ? {
                    name: rating.project.freelancer?.user.name,
                    profileImage: rating.project.freelancer?.user.profileImage,
                    role: 'FREELANCER'
                }
                : {
                    name: rating.project.client.user.name,
                    profileImage: rating.project.client.user.profileImage,
                    role: 'CLIENT'
                },
            createdAt: rating.createdAt
        }));

        res.status(200).json({
            success: true,
            data: {
                ratings: formattedRatings,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: totalRatings,
                    pages: Math.ceil(totalRatings / parseInt(limit))
                }
            }
        });

    } catch (error) {
        console.error('Get client ratings error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// PUT /api/client/ratings/:ratingId - Update a rating given by client
clientRouter.put('/ratings/:ratingId', authenticateToken, checkClientActive, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { ratingId } = req.params;
        const { rating, review } = req.body;

        // Validation
        if (rating && (rating < 1 || rating > 5)) {
            return res.status(400).json({
                success: false,
                message: 'Rating must be between 1 and 5 stars'
            });
        }

        // Check if rating exists and was given by this client
        const existingRating = await prisma.rating.findFirst({
            where: {
                id: ratingId,
                raterId: userId,
                raterType: 'CLIENT_TO_FREELANCER'
            },
            include: {
                project: {
                    include: {
                        freelancer: true
                    }
                }
            }
        });

        if (!existingRating) {
            return res.status(404).json({
                success: false,
                message: 'Rating not found or you do not have permission to update it'
            });
        }

        // Update rating in transaction to recalculate freelancer's average rating
        const result = await prisma.$transaction(async (tx) => {
            // Update the rating
            const updatedRating = await tx.rating.update({
                where: { id: ratingId },
                data: {
                    ...(rating && { rating: parseInt(rating) }),
                    ...(review !== undefined && { review }),
                    updatedAt: new Date()
                }
            });

            // Recalculate average rating for the freelancer
            const freelancerRatings = await tx.rating.findMany({
                where: {
                    ratedId: existingRating.project.freelancer.userId,
                    raterType: 'CLIENT_TO_FREELANCER'
                },
                select: {
                    rating: true
                }
            });

            const averageRating = freelancerRatings.reduce((sum, r) => sum + r.rating, 0) / freelancerRatings.length;

            // Update freelancer's average rating
            await tx.freelancer.update({
                where: { id: existingRating.project.assignedTo },
                data: {
                    ratings: parseFloat(averageRating.toFixed(2))
                }
            });

            return updatedRating;
        });

        // Invalidate relevant caches
        await deleteCache(`freelancer:profile:${existingRating.project.freelancer.userId}`);

        res.status(200).json({
            success: true,
            message: 'Rating updated successfully',
            data: result
        });

    } catch (error) {
        console.error('Update rating error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/client/meetings - Get all meetings for client
clientRouter.get('/meetings', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { status, page = 1, limit = 10 } = req.query;

        const cacheKey = `client:meetings:${userId}:status:${status || 'all'}:page:${page}:limit:${limit}`;
        
        const cachedMeetings = await getCache(cacheKey);
        if (cachedMeetings) {
            return res.status(200).json({
                success: true,
                data: cachedMeetings,
                cached: true
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        const whereClause = {
            clientId: client.id
        };

        if (status) {
            whereClause.status = status.toUpperCase();
        }

        const [meetings, totalMeetings] = await Promise.all([
            prisma.meeting.findMany({
                where: whereClause,
                include: {
                    project: {
                        select: {
                            title: true,
                            description: true
                        }
                    },
                    application: {
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
                        }
                    }
                },
                orderBy: {
                    scheduledDate: 'asc'
                },
                skip,
                take: parseInt(limit)
            }),
            prisma.meeting.count({
                where: whereClause
            })
        ]);

        const responseData = {
            meetings,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalMeetings,
                pages: Math.ceil(totalMeetings / parseInt(limit))
            }
        };

        await setCache(cacheKey, responseData, 180);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get meetings error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// PUT /api/client/meetings/:meetingId/reschedule - Reschedule a meeting
clientRouter.put('/meetings/:meetingId/reschedule', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { meetingId } = req.params;
        const { 
            newDate, 
            newTime, 
            newGoogleMeetLink,
            rescheduleReason, 
            timezone = 'UTC',
            duration 
        } = req.body;

        if (!newDate || !newTime || !rescheduleReason) {
            return res.status(400).json({
                success: false,
                message: 'New date, time, and reschedule reason are required'
            });
        }

        // Validate new meeting date is in the future
        const newScheduledDateTime = new Date(`${newDate}T${newTime}`);
        if (newScheduledDateTime <= new Date()) {
            return res.status(400).json({
                success: false,
                message: 'New meeting must be scheduled for a future date and time'
            });
        }

        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Check if meeting exists and belongs to this client
        const meeting = await prisma.meeting.findFirst({
            where: {
                id: meetingId,
                clientId: client.id
            },
            include: {
                application: {
                    include: {
                        freelancer: {
                            include: {
                                user: {
                                    select: {
                                        id: true,
                                        name: true,
                                        email: true
                                    }
                                }
                            }
                        }
                    }
                },
                project: {
                    select: {
                        title: true
                    }
                }
            }
        });

        if (!meeting) {
            return res.status(404).json({
                success: false,
                message: 'Meeting not found or you do not have permission to modify it'
            });
        }

        if (meeting.status === 'COMPLETED' || meeting.status === 'CANCELLED') {
            return res.status(400).json({
                success: false,
                message: 'Cannot reschedule a completed or cancelled meeting'
            });
        }

        // Update meeting
        const updatedMeeting = await prisma.meeting.update({
            where: { id: meetingId },
            data: {
                scheduledDate: new Date(newDate),
                scheduledTime: newTime,
                timezone,
                ...(duration && { duration: parseInt(duration) }),
                ...(newGoogleMeetLink && { googleMeetLink: newGoogleMeetLink }),
                rescheduleReason,
                status: 'RESCHEDULED',
                reminderSent: false // Reset reminder flag
            }
        });

        // Invalidate caches
        const freelancerUserId = meeting.application.freelancer.user.id;
        const cacheKeysToDelete = [
            `client:meetings:${userId}`,
            `freelancer:meetings:${freelancerUserId}`
        ];

        for (let page = 1; page <= 5; page++) {
            for (let limit of [10, 20, 50]) {
                cacheKeysToDelete.push(
                    `client:meetings:${userId}:status:all:page:${page}:limit:${limit}`,
                    `client:meetings:${userId}:status:SCHEDULED:page:${page}:limit:${limit}`,
                    `client:meetings:${userId}:status:RESCHEDULED:page:${page}:limit:${limit}`,
                    `freelancer:meetings:${freelancerUserId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:meetings:${freelancerUserId}:status:SCHEDULED:page:${page}:limit:${limit}`,
                    `freelancer:meetings:${freelancerUserId}:status:RESCHEDULED:page:${page}:limit:${limit}`
                );
            }
        }

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(200).json({
            success: true,
            message: 'Meeting rescheduled successfully',
            data: updatedMeeting
        });

    } catch (error) {
        console.error('Reschedule meeting error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// POST /api/client/applications/:applicationId/meetings - Schedule interview meeting with pending application
clientRouter.post('/applications/:applicationId/meetings', authenticateToken, checkClientActive, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { applicationId } = req.params;
        const { 
            googleMeetLink, 
            meetingDate, 
            meetingTime, 
            timezone = 'UTC',
            meetingTitle = 'Application Interview',
            duration = 60
        } = req.body;

        // Validation
        if (!googleMeetLink || !meetingDate || !meetingTime) {
            return res.status(400).json({
                success: false,
                message: 'Google Meet link, meeting date, and time are required'
            });
        }

        // Validate meeting date is in the future
        const scheduledDateTime = new Date(`${meetingDate}T${meetingTime}`);
        if (scheduledDateTime <= new Date()) {
            return res.status(400).json({
                success: false,
                message: 'Meeting must be scheduled for a future date and time'
            });
        }

        // Validate Google Meet link
        if (!googleMeetLink.includes('meet.google.com')) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid Google Meet link'
            });
        }

        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Get application and verify it belongs to client and is pending
        const application = await prisma.application.findFirst({
            where: {
                id: applicationId,
                status: 'PENDING',
                project: {
                    clientId: client.id
                }
            },
            include: {
                project: {
                    select: {
                        id: true,
                        title: true,
                        status: true
                    }
                },
                freelancer: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                isActive: true
                            }
                        }
                    }
                }
            }
        });

        if (!application) {
            return res.status(404).json({
                success: false,
                message: 'Application not found, not pending, or you do not have permission'
            });
        }

        // Check if freelancer is active
        if (!application.freelancer.user.isActive) {
            return res.status(400).json({
                success: false,
                message: 'Cannot schedule meeting. Freelancer account is inactive.'
            });
        }

        // Check if project is still open
        if (application.project.status !== 'OPEN') {
            return res.status(400).json({
                success: false,
                message: 'Project is no longer open for applications'
            });
        }

        // Create meeting
        const meeting = await prisma.meeting.create({
            data: {
                projectId: application.project.id,
                applicationId,
                clientId: client.id,
                freelancerId: application.freelancerId,
                title: meetingTitle || `Interview with ${application.freelancer.user.name}`,
                description: `Interview meeting to discuss application for project: ${application.project.title}. This is an opportunity to understand the project requirements better and showcase your skills.`,
                googleMeetLink,
                scheduledDate: new Date(meetingDate),
                scheduledTime: meetingTime,
                timezone,
                duration: parseInt(duration),
                notes: `Meeting Type: INTERVIEW | Application Status: PENDING`
            },
            include: {
                project: {
                    select: {
                        title: true
                    }
                },
                application: {
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
                    }
                }
            }
        });

        // Invalidate caches
        const freelancerUserId = application.freelancer.user.id;
        const cacheKeysToDelete = [
            `client:dashboard:${userId}`,
            `freelancer:dashboard:${freelancerUserId}`
        ];

        // Clear meeting caches
        for (let page = 1; page <= 5; page++) {
            for (let limit of [10, 20, 50]) {
                cacheKeysToDelete.push(
                    `client:meetings:${userId}:status:all:page:${page}:limit:${limit}`,
                    `client:meetings:${userId}:status:SCHEDULED:page:${page}:limit:${limit}`,
                    `freelancer:meetings:${freelancerUserId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:meetings:${freelancerUserId}:status:SCHEDULED:page:${page}:limit:${limit}`,
                    `client:application:${applicationId}:meetings:all`,
                    `freelancer:application:${applicationId}:meetings:all`
                );
            }
        }

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(201).json({
            success: true,
            message: 'Interview meeting scheduled successfully',
            data: meeting
        });

    } catch (error) {
        console.error('Create application meeting error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// PUT /api/client/meetings/:meetingId/action - Universal meeting action (reschedule/complete)
clientRouter.put('/meetings/:meetingId/action', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { meetingId } = req.params;
        const { 
            action, // 'reschedule' or 'complete'
            // For reschedule
            newDate,
            newTime,
            newGoogleMeetLink,
            rescheduleReason,
            timezone = 'UTC',
            duration,
            // For complete
            meetingNotes,
            nextSteps
        } = req.body;

        if (!action || !['reschedule', 'complete'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'Valid action is required: reschedule or complete'
            });
        }

        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Get meeting and verify ownership
        const meeting = await prisma.meeting.findFirst({
            where: {
                id: meetingId,
                clientId: client.id
            },
            include: {
                application: {
                    include: {
                        freelancer: {
                            include: {
                                user: {
                                    select: {
                                        id: true
                                    }
                                }
                            }
                        }
                    }
                },
                project: {
                    select: {
                        title: true
                    }
                }
            }
        });

        if (!meeting) {
            return res.status(404).json({
                success: false,
                message: 'Meeting not found or you do not have permission'
            });
        }

        let updatedMeeting;
        let message;

        if (action === 'reschedule') {
            // Validation for reschedule
            if (!newDate || !newTime || !rescheduleReason) {
                return res.status(400).json({
                    success: false,
                    message: 'New date, time, and reschedule reason are required'
                });
            }

            const newScheduledDateTime = new Date(`${newDate}T${newTime}`);
            if (newScheduledDateTime <= new Date()) {
                return res.status(400).json({
                    success: false,
                    message: 'New meeting must be scheduled for a future date and time'
                });
            }

            if (meeting.status === 'COMPLETED' || meeting.status === 'CANCELLED') {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot reschedule a completed or cancelled meeting'
                });
            }

            updatedMeeting = await prisma.meeting.update({
                where: { id: meetingId },
                data: {
                    scheduledDate: new Date(newDate),
                    scheduledTime: newTime,
                    timezone,
                    ...(duration && { duration: parseInt(duration) }),
                    ...(newGoogleMeetLink && { googleMeetLink: newGoogleMeetLink }),
                    rescheduleReason,
                    status: 'RESCHEDULED',
                    reminderSent: false
                }
            });
            message = 'Meeting rescheduled successfully';

        } else if (action === 'complete') {
            if (meeting.status === 'CANCELLED') {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot complete a cancelled meeting'
                });
            }

            updatedMeeting = await prisma.meeting.update({
                where: { id: meetingId },
                data: {
                    status: 'COMPLETED',
                    notes: meetingNotes ? `${meeting.notes || ''}\n\nMeeting Notes: ${meetingNotes}` : meeting.notes,
                    description: nextSteps ? `${meeting.description || ''}\n\nNext Steps: ${nextSteps}` : meeting.description
                }
            });
            message = 'Meeting marked as completed';
        }

        // Invalidate caches
        const freelancerUserId = meeting.application.freelancer.user.id;
        const cacheKeysToDelete = [
            `client:meetings:${userId}`,
            `freelancer:meetings:${freelancerUserId}`
        ];

        // Clear status-specific caches
        const statuses = ['all', 'SCHEDULED', 'RESCHEDULED', 'COMPLETED', 'CANCELLED'];
        for (let page = 1; page <= 5; page++) {
            for (let limit of [10, 20, 50]) {
                for (const status of statuses) {
                    cacheKeysToDelete.push(
                        `client:meetings:${userId}:status:${status}:page:${page}:limit:${limit}`,
                        `freelancer:meetings:${freelancerUserId}:status:${status}:page:${page}:limit:${limit}`
                    );
                }
            }
        }

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(200).json({
            success: true,
            message,
            data: updatedMeeting
        });

    } catch (error) {
        console.error('Meeting action error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});


// GET /api/client/applications/:applicationId/meetings - Get meetings for specific application
clientRouter.get('/applications/:applicationId/meetings', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { applicationId } = req.params;
        const { status, page = 1, limit = 10 } = req.query;

        const cacheKey = `client:application:${applicationId}:meetings:status:${status || 'all'}:page:${page}:limit:${limit}`;
        
        const cachedMeetings = await getCache(cacheKey);
        if (cachedMeetings) {
            return res.status(200).json({
                success: true,
                data: cachedMeetings,
                cached: true
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Verify application belongs to client
        const application = await prisma.application.findFirst({
            where: {
                id: applicationId,
                project: {
                    clientId: client.id
                }
            },
            include: {
                project: {
                    select: {
                        title: true
                    }
                },
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
            }
        });

        if (!application) {
            return res.status(404).json({
                success: false,
                message: 'Application not found or you do not have permission'
            });
        }

        const whereClause = {
            applicationId
        };

        if (status) {
            whereClause.status = status.toUpperCase();
        }

        const [meetings, totalMeetings] = await Promise.all([
            prisma.meeting.findMany({
                where: whereClause,
                include: {
                    project: {
                        select: {
                            title: true,
                            description: true
                        }
                    }
                },
                orderBy: {
                    scheduledDate: 'desc'
                },
                skip,
                take: parseInt(limit)
            }),
            prisma.meeting.count({
                where: whereClause
            })
        ]);

        const responseData = {
            application: {
                id: application.id,
                status: application.status,
                project: application.project,
                freelancer: application.freelancer
            },
            meetings,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalMeetings,
                pages: Math.ceil(totalMeetings / parseInt(limit))
            }
        };

        await setCache(cacheKey, responseData, 180);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get application meetings error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// PUT /api/client/meetings/:meetingId/cancel - Cancel a meeting
clientRouter.put('/meetings/:meetingId/cancel', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { meetingId } = req.params;
        const { cancellationReason } = req.body;

        if (!cancellationReason) {
            return res.status(400).json({
                success: false,
                message: 'Cancellation reason is required'
            });
        }

        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        const meeting = await prisma.meeting.findFirst({
            where: {
                id: meetingId,
                clientId: client.id
            },
            include: {
                application: {
                    include: {
                        freelancer: {
                            include: {
                                user: {
                                    select: {
                                        id: true
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        if (!meeting) {
            return res.status(404).json({
                success: false,
                message: 'Meeting not found or you do not have permission to modify it'
            });
        }

        if (meeting.status === 'COMPLETED' || meeting.status === 'CANCELLED') {
            return res.status(400).json({
                success: false,
                message: 'Meeting is already completed or cancelled'
            });
        }

        const updatedMeeting = await prisma.meeting.update({
            where: { id: meetingId },
            data: {
                status: 'CANCELLED',
                notes: cancellationReason
            }
        });

        // Invalidate caches
        const freelancerUserId = meeting.application.freelancer.user.id;
        const cacheKeysToDelete = [
            `client:meetings:${userId}`,
            `freelancer:meetings:${freelancerUserId}`
        ];

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(200).json({
            success: true,
            message: 'Meeting cancelled successfully',
            data: updatedMeeting
        });

    } catch (error) {
        console.error('Cancel meeting error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// PUT /api/client/meetings/:meetingId/complete - Mark meeting as completed
clientRouter.put('/meetings/:meetingId/complete', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { meetingId } = req.params;
        const { meetingNotes, nextSteps } = req.body;

        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        const meeting = await prisma.meeting.findFirst({
            where: {
                id: meetingId,
                clientId: client.id
            }
        });

        if (!meeting) {
            return res.status(404).json({
                success: false,
                message: 'Meeting not found or you do not have permission to modify it'
            });
        }

        const updatedMeeting = await prisma.meeting.update({
            where: { id: meetingId },
            data: {
                status: 'COMPLETED',
                notes: meetingNotes ? `${meeting.notes || ''}\n\nMeeting Notes: ${meetingNotes}` : meeting.notes,
                description: nextSteps ? `${meeting.description || ''}\n\nNext Steps: ${nextSteps}` : meeting.description
            }
        });

        res.status(200).json({
            success: true,
            message: 'Meeting marked as completed',
            data: updatedMeeting
        });

    } catch (error) {
        console.error('Complete meeting error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Error handling middleware for multer
clientRouter.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File size too large. Maximum size is 5MB.'
            });
        }
    }
    
    if (error.message === 'Only image files are allowed') {
        return res.status(400).json({
            success: false,
            message: 'Only image files are allowed for profile pictures.'
        });
    }
    
    next(error);
});

// UPDATE: PUT /api/client/projects/:projectId/applications/:applicationId/approve - Approve without mandatory meeting
clientRouter.put('/projects/:projectId/applications/:applicationId/approve', authenticateToken, checkClientActive, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId, applicationId } = req.params;

        // Check if user is a client
        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Check if project belongs to this client
        const project = await prisma.project.findFirst({
            where: {
                id: projectId,
                clientId: client.id
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found or you do not have permission to modify it'
            });
        }

        if (project.status !== 'OPEN') {
            return res.status(400).json({
                success: false,
                message: 'Project is not available for assignment'
            });
        }

        // Check if application exists and belongs to this project
        const application = await prisma.application.findFirst({
            where: {
                id: applicationId,
                projectId
            },
            include: {
                freelancer: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                profileImage: true
                            }
                        }
                    }
                }
            }
        });

        if (!application) {
            return res.status(404).json({
                success: false,
                message: 'Application not found'
            });
        }

        if (application.status !== 'PENDING') {
            return res.status(400).json({
                success: false,
                message: 'Application has already been processed'
            });
        }

        // Use transaction to approve application and assign project
        const result = await prisma.$transaction(async (tx) => {
            // Approve the application
            const approvedApplication = await tx.application.update({
                where: { id: applicationId },
                data: { status: 'APPROVED' },
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
                }
            });

            // Assign project to freelancer
            const updatedProject = await tx.project.update({
                where: { id: projectId },
                data: {
                    assignedTo: application.freelancerId,
                    status: 'ASSIGNED'
                }
            });

            // Reject all other pending applications for this project
            await tx.application.updateMany({
                where: {
                    projectId,
                    id: { not: applicationId },
                    status: 'PENDING'
                },
                data: { status: 'REJECTED' }
            });

            return { approvedApplication, updatedProject };
        });

        // COMPREHENSIVE CACHE INVALIDATION
        const freelancerUserId = application.freelancer.user.id;
        const cacheKeysToDelete = [
            `client:dashboard:${userId}`,
            `freelancer:dashboard:${freelancerUserId}`,
            'public:projects:available',
            'admin:dashboard:stats'
        ];

        // Add paginated caches for both client and freelancer
        for (let page = 1; page <= 10; page++) {
            for (let limit of [10, 20, 50]) {
                cacheKeysToDelete.push(
                    `client:projects:${userId}:status:all:page:${page}:limit:${limit}`,
                    `client:projects:${userId}:status:OPEN:page:${page}:limit:${limit}`,
                    `client:projects:${userId}:status:ASSIGNED:page:${page}:limit:${limit}`,
                    `client:applications:${userId}:status:all:page:${page}:limit:${limit}`,
                    `client:applications:${userId}:status:PENDING:page:${page}:limit:${limit}`,
                    `client:applications:${userId}:status:APPROVED:page:${page}:limit:${limit}`,
                    `client:applications:${userId}:status:REJECTED:page:${page}:limit:${limit}`,
                    `freelancer:applications:${freelancerUserId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:applications:${freelancerUserId}:status:PENDING:page:${page}:limit:${limit}`,
                    `freelancer:applications:${freelancerUserId}:status:APPROVED:page:${page}:limit:${limit}`,
                    `freelancer:projects:${freelancerUserId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:projects:${freelancerUserId}:status:ASSIGNED:page:${page}:limit:${limit}`,
                    `freelancer:available:projects:${freelancerUserId}:skills:default:budgetMin:any:budgetMax:any:page:${page}:limit:${limit}`
                );
            }
        }

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(200).json({
            success: true,
            message: 'Application approved and project assigned successfully',
            data: {
                application: result.approvedApplication,
                project: result.updatedProject
            }
        });

    } catch (error) {
        console.error('Approve application error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// POST /api/client/projects/:projectId/meetings - Create a new meeting for assigned project
clientRouter.post('/projects/:projectId/meetings', authenticateToken, checkClientActive, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId } = req.params;
        const { 
            googleMeetLink, 
            meetingDate, 
            meetingTime, 
            timezone = 'UTC',
            meetingTitle,
            meetingDescription,
            duration = 60,
            meetingType = 'GENERAL' // KICKOFF, PROGRESS, REVIEW, GENERAL
        } = req.body;

        // Validation for meeting details
        if (!googleMeetLink || !meetingDate || !meetingTime) {
            return res.status(400).json({
                success: false,
                message: 'Google Meet link, meeting date, and time are required'
            });
        }

        // Validate meeting date is in the future
        const scheduledDateTime = new Date(`${meetingDate}T${meetingTime}`);
        if (scheduledDateTime <= new Date()) {
            return res.status(400).json({
                success: false,
                message: 'Meeting must be scheduled for a future date and time'
            });
        }

        // Validate Google Meet link format
        if (!googleMeetLink.includes('meet.google.com')) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid Google Meet link'
            });
        }

        // Check if user is a client
        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Check if project belongs to this client and is assigned
        const project = await prisma.project.findFirst({
            where: {
                id: projectId,
                clientId: client.id,
                status: { in: ['ASSIGNED', 'PENDING_COMPLETION'] }
            },
            include: {
                freelancer: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                isActive: true
                            }
                        }
                    }
                }
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found, not assigned, or you do not have permission to create meetings'
            });
        }

        if (!project.freelancer) {
            return res.status(400).json({
                success: false,
                message: 'No freelancer assigned to this project'
            });
        }

        // Check if freelancer is still active
        if (!project.freelancer.user.isActive) {
            return res.status(400).json({
                success: false,
                message: 'Cannot create meeting. Freelancer account is inactive.'
            });
        }

        // Get the application for this project-freelancer combination
        const application = await prisma.application.findFirst({
            where: {
                projectId,
                freelancerId: project.assignedTo,
                status: 'APPROVED'
            }
        });

        if (!application) {
            return res.status(400).json({
                success: false,
                message: 'No approved application found for this project'
            });
               }

        // Create meeting
        const meeting = await prisma.meeting.create({
            data: {
                projectId,
                applicationId: application.id,
                clientId: client.id,
                freelancerId: project.assignedTo,
                title: meetingTitle || `${meetingType} Meeting: ${project.title}`,
                description: meetingDescription || `${meetingType} discussion for project: ${project.title}`,
                googleMeetLink,
                scheduledDate: new Date(meetingDate),
                scheduledTime: meetingTime,
                timezone,
                duration: parseInt(duration),
                notes: `Meeting Type: ${meetingType}`
            },
            include: {
                project: {
                    select: {
                        title: true,
                        description: true
                    }
                },
                application: {
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
                    }
                }
            }
        });

        // Invalidate meeting caches for both client and freelancer
        const freelancerUserId = project.freelancer.user.id;
        const cacheKeysToDelete = [
            `client:dashboard:${userId}`,
            `freelancer:dashboard:${freelancerUserId}`
        ];

        // Clear meeting list caches
        for (let page = 1; page <= 10; page++) {
            for (let limit of [10, 20, 50]) {
                cacheKeysToDelete.push(
                    `client:meetings:${userId}:status:all:page:${page}:limit:${limit}`,
                    `client:meetings:${userId}:status:SCHEDULED:page:${page}:limit:${limit}`,
                    `freelancer:meetings:${freelancerUserId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:meetings:${freelancerUserId}:status:SCHEDULED:page:${page}:limit:${limit}`,
                    `client:project:${projectId}:meetings:status:all:page:${page}:limit:${limit}`,
                    `freelancer:project:${projectId}:meetings:status:all:page:${page}:limit:${limit}`
                );
            }
        }

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(201).json({
            success: true,
            message: 'Meeting scheduled successfully',
            data: meeting
        });

    } catch (error) {
        console.error('Create meeting error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/client/projects/:projectId/meetings - Get all meetings for a specific project
clientRouter.get('/projects/:projectId/meetings', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId } = req.params;
        const { status, page = 1, limit = 10 } = req.query;

        const cacheKey = `client:project:${projectId}:meetings:status:${status || 'all'}:page:${page}:limit:${limit}`;
        
        const cachedMeetings = await getCache(cacheKey);
        if (cachedMeetings) {
            return res.status(200).json({
                success: true,
                data: cachedMeetings,
                cached: true
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Verify project belongs to client
        const project = await prisma.project.findFirst({
            where: {
                id: projectId,
                clientId: client.id
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found or you do not have permission to view it'
            });
        }

        const whereClause = {
            projectId
        };

        if (status) {
            whereClause.status = status.toUpperCase();
        }

        const [meetings, totalMeetings] = await Promise.all([
            prisma.meeting.findMany({
                where: whereClause,
                include: {
                    project: {
                        select: {
                            title: true,
                            description: true
                        }
                    },
                    application: {
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
                        }
                    }
                },
                orderBy: {
                    scheduledDate: 'desc'
                },
                skip,
                take: parseInt(limit)
            }),
            prisma.meeting.count({
                where: whereClause
            })
        ]);

        const responseData = {
            meetings,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalMeetings,
                pages: Math.ceil(totalMeetings / parseInt(limit))
            }
        };

        await setCache(cacheKey, responseData, 180);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get project meetings error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/client/meeting-requests - Get all meeting requests received by client
clientRouter.get('/meeting-requests', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { status, page = 1, limit = 10 } = req.query;

        const cacheKey = `client:meeting-requests:${userId}:status:${status || 'all'}:page:${page}:limit:${limit}`;
        
        const cachedRequests = await getCache(cacheKey);
        if (cachedRequests) {
            return res.status(200).json({
                success: true,
                data: cachedRequests,
                cached: true
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        const whereClause = {
            clientId: client.id
        };

        if (status) {
            whereClause.status = status.toUpperCase();
        }

        const [requests, totalRequests] = await Promise.all([
            prisma.meetingRequest.findMany({
                where: whereClause,
                include: {
                    project: {
                        select: {
                            title: true,
                            description: true
                        }
                    },
                    application: {
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
                        }
                    },
                    createdMeeting: {
                        select: {
                            id: true,
                            title: true,
                            scheduledDate: true,
                            scheduledTime: true,
                            googleMeetLink: true,
                            status: true
                        }
                    }
                },
                orderBy: [
                    { urgency: 'desc' }, // Show urgent requests first
                    { createdAt: 'desc' }
                ],
                skip,
                take: parseInt(limit)
            }),
            prisma.meetingRequest.count({
                where: whereClause
            })
        ]);

        const responseData = {
            requests,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalRequests,
                pages: Math.ceil(totalRequests / parseInt(limit))
            }
        };

        await setCache(cacheKey, responseData, 180);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get meeting requests error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// PUT /api/client/meeting-requests/:requestId/approve - Approve meeting request and create meeting
clientRouter.put('/meeting-requests/:requestId/approve', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { requestId } = req.params;
        const { 
            googleMeetLink, 
            meetingDate, 
            meetingTime, 
            timezone = 'UTC',
            meetingTitle,
            duration,
            responseNote
        } = req.body;

        // Validation for meeting details
        if (!googleMeetLink || !meetingDate || !meetingTime) {
            return res.status(400).json({
                success: false,
                message: 'Google Meet link, meeting date, and time are required'
            });
        }

        // Validate meeting date is in the future
        const scheduledDateTime = new Date(`${meetingDate}T${meetingTime}`);
        if (scheduledDateTime <= new Date()) {
            return res.status(400).json({
                success: false,
                message: 'Meeting must be scheduled for a future date and time'
            });
        }

        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        // Get meeting request
        const meetingRequest = await prisma.meetingRequest.findFirst({
            where: {
                id: requestId,
                clientId: client.id,
                status: 'PENDING'
            },
            include: {
                project: {
                    select: {
                        title: true
                    }
                },
                application: {
                    include: {
                        freelancer: {
                            include: {
                                user: {
                                    select: {
                                        id: true
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        if (!meetingRequest) {
            return res.status(404).json({
                success: false,
                message: 'Meeting request not found or already processed'
            });
        }

        // Create meeting and update request in transaction
        const result = await prisma.$transaction(async (tx) => {
            // Create the meeting
            const meeting = await tx.meeting.create({
                data: {
                    projectId: meetingRequest.projectId,
                    applicationId: meetingRequest.applicationId,
                    clientId: client.id,
                    freelancerId: meetingRequest.freelancerId,
                    title: meetingTitle || `${meetingRequest.meetingType} Meeting: ${meetingRequest.project.title}`,
                    description: meetingRequest.description,
                    googleMeetLink,
                    scheduledDate: new Date(meetingDate),
                    scheduledTime: meetingTime,
                    timezone,
                    duration: parseInt(duration || meetingRequest.preferredDuration),
                    notes: `Created from meeting request. Original reason: ${meetingRequest.requestReason}`
                }
            });

            // Update meeting request status
            const updatedRequest = await tx.meetingRequest.update({
                where: { id: requestId },
                data: {
                    status: 'APPROVED',
                    responseNote,
                    createdMeetingId: meeting.id,
                    respondedAt: new Date()
                }
            });

            return { meeting, updatedRequest };
        });

        // Invalidate caches
        const freelancerUserId = meetingRequest.application.freelancer.user.id;
        const cacheKeysToDelete = [
            `client:dashboard:${userId}`,
            `freelancer:dashboard:${freelancerUserId}`
        ];

        // Clear meeting and request caches
        for (let page = 1; page <= 10; page++) {
            for (let limit of [10, 20, 50]) {
                cacheKeysToDelete.push(
                    `client:meeting-requests:${userId}:status:all:page:${page}:limit:${limit}`,
                    `client:meeting-requests:${userId}:status:PENDING:page:${page}:limit:${limit}`,
                    `client:meeting-requests:${userId}:status:APPROVED:page:${page}:limit:${limit}`,
                    `client:meetings:${userId}:status:all:page:${page}:limit:${limit}`,
                    `client:meetings:${userId}:status:SCHEDULED:page:${page}:limit:${limit}`,
                    `freelancer:meeting-requests:${freelancerUserId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:meeting-requests:${freelancerUserId}:status:APPROVED:page:${page}:limit:${limit}`,
                    `freelancer:meetings:${freelancerUserId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:meetings:${freelancerUserId}:status:SCHEDULED:page:${page}:limit:${limit}`
                );
            }
        }

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(200).json({
            success: true,
            message: 'Meeting request approved and meeting scheduled successfully',
            data: {
                meeting: result.meeting,
                request: result.updatedRequest
            }
        });

    } catch (error) {
        console.error('Approve meeting request error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// PUT /api/client/meeting-requests/:requestId/reject - Reject meeting request
clientRouter.put('/meeting-requests/:requestId/reject', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { requestId } = req.params;
        const { rejectionReason } = req.body;

        if (!rejectionReason) {
            return res.status(400).json({
                success: false,
                message: 'Rejection reason is required'
            });
        }

        const client = await prisma.client.findUnique({
            where: { userId }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found'
            });
        }

        const meetingRequest = await prisma.meetingRequest.findFirst({
            where: {
                id: requestId,
                clientId: client.id,
                status: 'PENDING'
            },
            include: {
                application: {
                    include: {
                        freelancer: {
                            include: {
                                user: {
                                    select: {
                                        id: true
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        if (!meetingRequest) {
            return res.status(404).json({
                success: false,
                message: 'Meeting request not found or already processed'
            });
        }

        // Update meeting request status
        const updatedRequest = await prisma.meetingRequest.update({
            where: { id: requestId },
            data: {
                status: 'REJECTED',
                responseNote: rejectionReason,
                respondedAt: new Date()
            }
        });

        // Invalidate caches
        const freelancerUserId = meetingRequest.application.freelancer.user.id;
        const cacheKeysToDelete = [
            `client:meeting-requests:${userId}`,
            `freelancer:meeting-requests:${freelancerUserId}`
        ];

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(200).json({
            success: true,
            message: 'Meeting request rejected successfully',
            data: updatedRequest
        });

    } catch (error) {
        console.error('Reject meeting request error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});


