import { Router } from "express";
import multer from "multer";
import {
    signup,
    login,
    updateProfile,
    getProfile,
    updateAvailability,
    forgotPassword,
    verifyOTPEndpoint
} from "./auth.js";

import { authenticateToken, checkFreelancerActive } from "../middleware/auth.js";
import { setCache, getCache, deleteCache } from "../utils/redis.js";
import prisma from "../prisma.config.js";
// Add these imports at the top


export const flRouter = Router();

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

// Authentication Routes (Public)
flRouter.post('/signup', upload.single('profileImage'), signup);
flRouter.post('/login', login);
// Add these routes
flRouter.post('/forgot-password', forgotPassword);
flRouter.post('/verify-otp', verifyOTPEndpoint);

flRouter.get('/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const cacheKey = `freelancer:profile:${userId}`;

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
                freelancer: true
            }
        });

        if (!user || user.role !== 'FREELANCER') {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
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

flRouter.put('/profile', authenticateToken, checkFreelancerActive, upload.single('profileImage'), async (req, res) => {
    try {
        const userId = req.user.userId;

        // Update profile logic...
        const result = await updateProfile(req, res);

        // Invalidate cache
        const cacheKey = `freelancer:profile:${userId}`;
        await deleteCache(cacheKey);

        return result;
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/freelancer/dashboard - Get dashboard data
flRouter.get('/dashboard', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const cacheKey = `freelancer:dashboard:${userId}`;

        // Check cache
        const cachedDashboard = await getCache(cacheKey);
        if (cachedDashboard) {
            return res.status(200).json({
                success: true,
                data: cachedDashboard
            });
        }

        // Fetch dashboard data from database
        const freelancer = await prisma.freelancer.findUnique({
            where: { userId },
            include: {
                assignedProjects: true,
                applications: true,
                user: {
                    select: {
                        isActive: true
                    }
                }
            }
        });

        if (!freelancer) {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
            });
        }

        const stats = {
            totalProjects: freelancer.projectsCompleted,
            activeProjects: freelancer.assignedProjects.filter(p => p.status === 'ASSIGNED').length,
            completedProjects: freelancer.assignedProjects.filter(p => p.status === 'COMPLETED').length,
            pendingApplications: freelancer.applications.filter(app => app.status === 'PENDING').length,
            accountStatus: freelancer.user.isActive ? 'active' : 'suspended'
        };

        const dashboardData = { freelancer, stats };

        // Cache the dashboard data
        await setCache(cacheKey, dashboardData, 300); // Cache for 5 minutes

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

// GET /api/freelancer/projects - Get freelancer's projects
flRouter.get('/projects', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { status, page = 1, limit = 10 } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const whereClause = {
            freelancer: {
                userId
            }
        };

        if (status) {
            whereClause.status = status.toUpperCase();
        }

        const projects = await prisma.project.findMany({
            where: whereClause,
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
            },
            orderBy: {
                createdAt: 'desc'
            },
            skip,
            take: parseInt(limit)
        });

        const totalProjects = await prisma.project.count({
            where: whereClause
        });

        res.status(200).json({
            success: true,
            data: {
                projects,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: totalProjects,
                    pages: Math.ceil(totalProjects / parseInt(limit))
                }
            }
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

// GET /api/freelancer/projects/available - Get available projects for freelancer
flRouter.get('/projects/available', authenticateToken, checkFreelancerActive, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { skills, budgetMin, budgetMax, page = 1, limit = 10 } = req.query;

        // Create specific cache key based on query parameters
        const skillsParam = skills || 'default';
        const budgetMinParam = budgetMin || 'any';
        const budgetMaxParam = budgetMax || 'any';
        const cacheKey = `freelancer:available:projects:${userId}:skills:${skillsParam}:budgetMin:${budgetMinParam}:budgetMax:${budgetMaxParam}:page:${page}:limit:${limit}`;

        // Check cache first (shorter duration for real-time updates)
        const cachedProjects = await getCache(cacheKey);
        if (cachedProjects) {
            return res.status(200).json({
                success: true,
                data: cachedProjects,
                cached: true
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Use freelancer from middleware
        const freelancer = req.freelancer;

        const whereClause = {
            status: 'OPEN',
            assignedTo: null,
            client: {
                user: {
                    isActive: true // Only show projects from active clients
                }
            }
        };

        // Filter by skills if provided, otherwise use freelancer's skills
        const skillsToFilter = skills ? skills.split(',').map(s => s.trim()) : freelancer.skills;
        if (skillsToFilter.length > 0) {
            whereClause.skillsRequired = {
                hasSome: skillsToFilter
            };
        }

        // Filter by budget
        if (budgetMin) {
            whereClause.budgetMin = { gte: parseFloat(budgetMin) };
        }
        if (budgetMax) {
            whereClause.budgetMax = { lte: parseFloat(budgetMax) };
        }

        const [projects, totalProjects] = await Promise.all([
            prisma.project.findMany({
                where: whereClause,
                include: {
                    client: {
                        include: {
                            user: {
                                select: {
                                    name: true,
                                    profileImage: true,
                                    location: true
                                }
                            }
                        }
                    },
                    applications: {
                        where: {
                            freelancerId: freelancer.id
                        },
                        select: {
                            id: true,
                            status: true,
                            createdAt: true
                        }
                    },
                    _count: {
                        select: {
                            applications: true
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

        // Format projects with additional metadata
        const formattedProjects = projects.map(project => ({
            ...project,
            myApplication: project.applications.length > 0 ? project.applications[0] : null,
            totalApplications: project._count.applications,
            isMatch: skillsToFilter.some(skill => project.skillsRequired.includes(skill))
        }));

        const responseData = {
            projects: formattedProjects,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalProjects,
                pages: Math.ceil(totalProjects / parseInt(limit))
            },
            filters: {
                skills: skillsToFilter,
                budgetMin: budgetMin ? parseFloat(budgetMin) : null,
                budgetMax: budgetMax ? parseFloat(budgetMax) : null
            }
        };

        // Cache for 3 minutes (projects change frequently)
        await setCache(cacheKey, responseData, 180);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get available projects error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// UPDATE: GET /api/freelancer/projects - Get freelancer's projects with caching
flRouter.get('/projects', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { status, page = 1, limit = 10 } = req.query;

        // Create cache key based on query parameters
        const cacheKey = `freelancer:projects:${userId}:status:${status || 'all'}:page:${page}:limit:${limit}`;

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

        const whereClause = {
            freelancer: {
                userId
            }
        };

        if (status) {
            whereClause.status = status.toUpperCase();
        }

        const [projects, totalProjects] = await Promise.all([
            prisma.project.findMany({
                where: whereClause,
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

// UPDATE: POST /api/freelancer/projects/:projectId/apply - Apply for a project with cache invalidation
flRouter.post('/projects/:projectId/apply', authenticateToken, checkFreelancerActive, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId } = req.params;
        const { proposal, coverLetter } = req.body;

        // Use freelancer from middleware
        const freelancer = req.freelancer;

        if (!freelancer.availability) {
            return res.status(400).json({
                success: false,
                message: 'You must be available to apply for projects'
            });
        }

        // Check if project exists and is open
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            include: {
                client: {
                    include: {
                        user: {
                            select: {
                                name: true,
                                profileImage: true,
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
                message: 'Project not found'
            });
        }

        // Check if client is also active
        if (!project.client.user.isActive) {
            return res.status(400).json({
                success: false,
                message: 'This project is no longer available'
            });
        }

        if (project.status !== 'OPEN') {
            return res.status(400).json({
                success: false,
                message: 'Project is not available for applications'
            });
        }

        if (project.assignedTo) {
            return res.status(400).json({
                success: false,
                message: 'Project is already assigned'
            });
        }

        // Check if freelancer has already applied
        const existingApplication = await prisma.application.findUnique({
            where: {
                projectId_freelancerId: {
                    projectId,
                    freelancerId: freelancer.id
                }
            }
        });

        if (existingApplication) {
            return res.status(400).json({
                success: false,
                message: 'You have already applied for this project'
            });
        }

        // Create application
        const application = await prisma.application.create({
            data: {
                projectId,
                freelancerId: freelancer.id,
                proposal,
                coverLetter
            },
            include: {
                project: {
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
        });

        // COMPREHENSIVE CACHE INVALIDATION FOR APPLICATION CREATION
        const cacheKeysToDelete = [
            // Freelancer caches
            `freelancer:dashboard:${userId}`,
            
            // Client caches (project now has new application)
            `client:dashboard:${project.client.userId}`,
            `client:projects:${project.client.userId}`,
            
            // Project-specific caches
            `project:${projectId}:applications`,
            
            // Public caches
            'public:projects:available',
            'admin:dashboard:stats'
        ];

        // Add paginated caches for both freelancer and client
        for (let page = 1; page <= 10; page++) {
            for (let limit of [10, 20, 50]) {
                // Freelancer application caches
                cacheKeysToDelete.push(
                    `freelancer:applications:${userId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:applications:${userId}:status:PENDING:page:${page}:limit:${limit}`,
                    `freelancer:applications:${userId}:status:APPROVED:page:${page}:limit:${limit}`,
                    `freelancer:applications:${userId}:status:REJECTED:page:${page}:limit:${limit}`
                );
                
                // Available projects caches (this project might now show as applied)
                cacheKeysToDelete.push(
                    `freelancer:available:projects:${userId}:skills:default:budgetMin:any:budgetMax:any:page:${page}:limit:${limit}`
                );
                
                // Client project and application caches
                cacheKeysToDelete.push(
                    `client:projects:${project.client.userId}:status:all:page:${page}:limit:${limit}`,
                    `client:projects:${project.client.userId}:status:OPEN:page:${page}:limit:${limit}`,
                    `client:applications:${project.client.userId}:status:all:page:${page}:limit:${limit}`,
                    `client:applications:${project.client.userId}:status:PENDING:page:${page}:limit:${limit}`
                );
            }
        }

        // Also clear skill-based available project caches
        if (freelancer.skills && freelancer.skills.length > 0) {
            const skillsString = freelancer.skills.join(',');
            for (let page = 1; page <= 5; page++) {
                for (let limit of [10, 20, 50]) {
                    cacheKeysToDelete.push(
                        `freelancer:available:projects:${userId}:skills:${skillsString}:budgetMin:any:budgetMax:any:page:${page}:limit:${limit}`
                    );
                }
            }
        }

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(201).json({
            success: true,
            message: 'Application submitted successfully',
            data: application
        });

    } catch (error) {
        console.error('Apply for project error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// UPDATE: GET /api/freelancer/applications - Get all applications with caching
flRouter.get('/applications', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { status, page = 1, limit = 10 } = req.query;

        // Create cache key based on query parameters
        const cacheKey = `freelancer:applications:${userId}:status:${status || 'all'}:page:${page}:limit:${limit}`;

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

        const freelancer = await prisma.freelancer.findUnique({
            where: { userId },
            select: { id: true }
        });

        if (!freelancer) {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
            });
        }

        const whereClause = {
            freelancerId: freelancer.id
        };

        if (status) {
            whereClause.status = status.toUpperCase();
        }

        const [applications, totalApplications] = await Promise.all([
            prisma.application.findMany({
                where: whereClause,
                include: {
                    project: {
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

        // Cache for shorter duration (2 minutes for real-time feel)
        await setCache(cacheKey, responseData, 120);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get applications error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// UPDATE: GET /api/freelancer/dashboard - Get dashboard data with shorter cache
flRouter.get('/dashboard', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const cacheKey = `freelancer:dashboard:${userId}`;

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
        const freelancer = await prisma.freelancer.findUnique({
            where: { userId },
            include: {
                assignedProjects: {
                    orderBy: {
                        createdAt: 'desc'
                    },
                    take: 5 // Show 5 most recent projects
                },
                applications: {
                    orderBy: {
                        createdAt: 'desc'
                    },
                    take: 5 // Show 5 most recent applications
                },
                user: {
                    select: {
                        isActive: true
                    }
                }
            }
        });

        if (!freelancer) {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
            });
        }

        const stats = {
            totalProjects: freelancer.projectsCompleted,
            activeProjects: freelancer.assignedProjects.filter(p => p.status === 'ASSIGNED').length,
            completedProjects: freelancer.assignedProjects.filter(p => p.status === 'COMPLETED').length,
            pendingApplications: freelancer.applications.filter(app => app.status === 'PENDING').length,
            approvedApplications: freelancer.applications.filter(app => app.status === 'APPROVED').length,
            accountStatus: freelancer.user.isActive ? 'active' : 'suspended'
        };

        const dashboardData = { 
            freelancer, 
            stats,
            recentProjects: freelancer.assignedProjects,
            recentApplications: freelancer.applications
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

// UPDATE: PUT /api/freelancer/projects/:projectId/request-completion - Request project completion with cache invalidation
flRouter.put('/projects/:projectId/request-completion', authenticateToken, checkFreelancerActive, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId } = req.params;
        const { deliverables, completionNote } = req.body;

        // Use freelancer from middleware
        const freelancer = req.freelancer;

        // Check if project exists and is assigned to this freelancer
        const project = await prisma.project.findFirst({
            where: {
                id: projectId,
                assignedTo: freelancer.id,
                status: 'ASSIGNED'
            },
            include: {
                client: {
                    include: {
                        user: true
                    }
                }
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found, not assigned to you, or not in correct status'
            });
        }

        // Check if client is still active
        if (!project.client.user.isActive) {
            return res.status(400).json({
                success: false,
                message: 'Cannot request completion. Client account is inactive.'
            });
        }

        // Update project status to PENDING_COMPLETION
        const updatedProject = await prisma.project.update({
            where: { id: projectId },
            data: { 
                status: 'PENDING_COMPLETION',
                updatedAt: new Date()
            },
            include: {
                client: {
                    include: {
                        user: true
                    }
                }
            }
        });

        // COMPREHENSIVE CACHE INVALIDATION FOR COMPLETION REQUEST
        const cacheKeysToDelete = [
            // Freelancer caches
            `freelancer:dashboard:${userId}`,
            
            // Client caches (project status changed)
            `client:dashboard:${project.client.userId}`,
            
            // Public caches
            'admin:dashboard:stats'
        ];

        // Add paginated caches for both users
        for (let page = 1; page <= 10; page++) {
            for (let limit of [10, 20, 50]) {
                // Freelancer project caches
                cacheKeysToDelete.push(
                    `freelancer:projects:${userId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:projects:${userId}:status:ASSIGNED:page:${page}:limit:${limit}`,
                    `freelancer:projects:${userId}:status:PENDING_COMPLETION:page:${page}:limit:${limit}`
                );
                
                // Client project caches
                cacheKeysToDelete.push(
                    `client:projects:${project.client.userId}:status:all:page:${page}:limit:${limit}`,
                    `client:projects:${project.client.userId}:status:ASSIGNED:page:${page}:limit:${limit}`,
                    `client:projects:${project.client.userId}:status:PENDING_COMPLETION:page:${page}:limit:${limit}`
                );
            }
        }

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(200).json({
            success: true,
            message: 'Completion request submitted. Awaiting client approval.',
            data: updatedProject
        });

    } catch (error) {
        console.error('Request project completion error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// POST /api/freelancer/projects/:projectId/rate-client - Rate a client after project completion
flRouter.post('/projects/:projectId/rate-client', authenticateToken, checkFreelancerActive, async (req, res) => {
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

        // Use freelancer from middleware
        const freelancer = req.freelancer;

        // Check if project exists, is completed, and was assigned to this freelancer
        const project = await prisma.project.findFirst({
            where: {
                id: projectId,
                assignedTo: freelancer.id,
                status: 'COMPLETED'
            },
            include: {
                client: {
                    include: {
                        user: true
                    }
                }
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found, not completed, or not assigned to you'
            });
        }

        // Check if freelancer has already rated this client for this project
        const existingRating = await prisma.rating.findUnique({
            where: {
                projectId_raterId_ratedId: {
                    projectId,
                    raterId: userId,
                    ratedId: project.client.userId
                }
            }
        });

        if (existingRating) {
            return res.status(400).json({
                success: false,
                message: 'You have already rated this client for this project'
            });
        }

        // Create rating in transaction to update client's average rating
        const result = await prisma.$transaction(async (tx) => {
            // Create the rating
            const newRating = await tx.rating.create({
                data: {
                    projectId,
                    raterId: userId,
                    ratedId: project.client.userId,
                    raterType: 'FREELANCER_TO_CLIENT',
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

            // Calculate new average rating for the client
            const clientRatings = await tx.rating.findMany({
                where: {
                    ratedId: project.client.userId,
                    raterType: 'FREELANCER_TO_CLIENT'
                },
                select: {
                    rating: true
                }
            });

            const averageRating = clientRatings.reduce((sum, r) => sum + r.rating, 0) / clientRatings.length;

            // Update client's average rating
            await tx.client.update({
                where: { id: project.clientId },
                data: {
                    ratings: parseFloat(averageRating.toFixed(2))
                }
            });

            return newRating;
        });

        // Comprehensive cache invalidation
        const cacheKeysToDelete = [
            // Client related caches
            `client:profile:${project.client.userId}`,
            `client:ratings:${project.client.userId}:all`,
            `client:ratings:${project.client.userId}:received`,
            `client:ratings:${project.client.userId}:given`,
            
            // Freelancer related caches
            `freelancer:ratings:${userId}:all`,
            `freelancer:ratings:${userId}:given`,
            `freelancer:ratings:${userId}:received`,
            
            // Public caches
            `public:user:${project.client.userId}:ratings`,
            `public:featured:freelancers`,
            `public:featured:clients`,
            
            // Admin caches
            `admin:dashboard:stats`
        ];

        // Delete all rating page caches for both users
        for (let page = 1; page <= 10; page++) {
            for (let limit of [10, 20, 50]) {
                cacheKeysToDelete.push(
                    `freelancer:ratings:${userId}:all:page:${page}:limit:${limit}`,
                    `freelancer:ratings:${userId}:given:page:${page}:limit:${limit}`,
                    `freelancer:ratings:${userId}:received:page:${page}:limit:${limit}`,
                    `client:ratings:${project.client.userId}:all:page:${page}:limit:${limit}`,
                    `client:ratings:${project.client.userId}:given:page:${page}:limit:${limit}`,
                    `client:ratings:${project.client.userId}:received:page:${page}:limit:${limit}`
                );
            }
        }

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(201).json({
            success: true,
            message: 'Client rated successfully',
            data: result
        });

    } catch (error) {
        console.error('Rate client error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/freelancer/ratings - Get all ratings given and received by freelancer
flRouter.get('/ratings', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { type = 'all', page = 1, limit = 10 } = req.query;

        // Create specific cache key based on query parameters
        const cacheKey = `freelancer:ratings:${userId}:${type}:page:${page}:limit:${limit}`;

        // Check cache first
        const cachedRatings = await getCache(cacheKey);
        if (cachedRatings) {
            return res.status(200).json({
                success: true,
                data: cachedRatings,
                cached: true
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const freelancer = await prisma.freelancer.findUnique({
            where: { userId },
            select: { id: true }
        });

        if (!freelancer) {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
            });
        }

        let whereClause = {};

        if (type === 'given') {
            // Ratings given by this freelancer to clients
            whereClause = {
                raterId: userId,
                raterType: 'FREELANCER_TO_CLIENT'
            };
        } else if (type === 'received') {
            // Ratings received by this freelancer from clients
            whereClause = {
                ratedId: userId,
                raterType: 'CLIENT_TO_FREELANCER'
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
                    name: rating.project.client.user.name,
                    profileImage: rating.project.client.user.profileImage,
                    role: 'CLIENT'
                }
                : {
                    name: rating.project.freelancer?.user.name,
                    profileImage: rating.project.freelancer?.user.profileImage,
                    role: 'FREELANCER'
                },
            createdAt: rating.createdAt
        }));

        const responseData = {
            ratings: formattedRatings,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalRatings,
                pages: Math.ceil(totalRatings / parseInt(limit))
            }
        };

        // Cache the response for 15 minutes (ratings don't change frequently)
        await setCache(cacheKey, responseData, 900);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get freelancer ratings error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// PUT /api/freelancer/ratings/:ratingId - Update a rating given by freelancer
flRouter.put('/ratings/:ratingId', authenticateToken, checkFreelancerActive, async (req, res) => {
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

        // Check if rating exists and was given by this freelancer
        const existingRating = await prisma.rating.findFirst({
            where: {
                id: ratingId,
                raterId: userId,
                raterType: 'FREELANCER_TO_CLIENT'
            },
            include: {
                project: {
                    include: {
                        client: true
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

        // Update rating in transaction to recalculate client's average rating
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

            // Recalculate average rating for the client
            const clientRatings = await tx.rating.findMany({
                where: {
                    ratedId: existingRating.project.client.userId,
                    raterType: 'FREELANCER_TO_CLIENT'
                },
                select: {
                    rating: true
                }
            });

            const averageRating = clientRatings.reduce((sum, r) => sum + r.rating, 0) / clientRatings.length;

            // Update client's average rating
            await tx.client.update({
                where: { id: existingRating.project.clientId },
                data: {
                    ratings: parseFloat(averageRating.toFixed(2))
                }
            });

            return updatedRating;
        });

        // Comprehensive cache invalidation for rating updates
        const cacheKeysToDelete = [
            // Client related caches
            `client:profile:${existingRating.project.client.userId}`,
            
            // Public caches
            `public:user:${existingRating.project.client.userId}:ratings`,
            `public:featured:freelancers`,
            `public:featured:clients`
        ];

        // Delete all rating page caches for both users
        for (let page = 1; page <= 10; page++) {
            for (let limit of [10, 20, 50]) {
                cacheKeysToDelete.push(
                    `freelancer:ratings:${userId}:all:page:${page}:limit:${limit}`,
                    `freelancer:ratings:${userId}:given:page:${page}:limit:${limit}`,
                    `freelancer:ratings:${userId}:received:page:${page}:limit:${limit}`,
                    `client:ratings:${existingRating.project.client.userId}:all:page:${page}:limit:${limit}`,
                    `client:ratings:${existingRating.project.client.userId}:given:page:${page}:limit:${limit}`,
                    `client:ratings:${existingRating.project.client.userId}:received:page:${page}:limit:${limit}`
                );
            }
        }

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

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

// GET /api/freelancer/ratings/stats - Get rating statistics for freelancer
flRouter.get('/ratings/stats', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const cacheKey = `freelancer:ratings:stats:${userId}`;

        // Check cache first
        const cachedStats = await getCache(cacheKey);
        if (cachedStats) {
            return res.status(200).json({
                success: true,
                data: cachedStats,
                cached: true
            });
        }

        const freelancer = await prisma.freelancer.findUnique({
            where: { userId },
            select: { id: true, ratings: true }
        });

        if (!freelancer) {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
            });
        }

        // Get detailed rating statistics
        const [
            receivedRatings,
            givenRatings,
            ratingDistribution
        ] = await Promise.all([
            // Ratings received from clients
            prisma.rating.findMany({
                where: {
                    ratedId: userId,
                    raterType: 'CLIENT_TO_FREELANCER'
                },
                select: {
                    rating: true,
                    createdAt: true
                }
            }),
            // Ratings given to clients
            prisma.rating.count({
                where: {
                    raterId: userId,
                    raterType: 'FREELANCER_TO_CLIENT'
                }
            }),
            // Rating distribution
            prisma.rating.groupBy({
                by: ['rating'],
                where: {
                    ratedId: userId,
                    raterType: 'CLIENT_TO_FREELANCER'
                },
                _count: {
                    rating: true
                }
            })
        ]);

        // Calculate statistics
        const totalReceivedRatings = receivedRatings.length;
        const averageRating = totalReceivedRatings > 0 
            ? receivedRatings.reduce((sum, r) => sum + r.rating, 0) / totalReceivedRatings 
            : 0;

        // Create rating distribution object
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        ratingDistribution.forEach(item => {
            distribution[item.rating] = item._count.rating;
        });

        // Calculate recent ratings (last 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const recentRatings = receivedRatings.filter(
            rating => new Date(rating.createdAt) >= thirtyDaysAgo
        );

        const statsData = {
            overview: {
                averageRating: parseFloat(averageRating.toFixed(2)),
                totalReceived: totalReceivedRatings,
                totalGiven: givenRatings,
                recentRatingsCount: recentRatings.length
            },
            distribution,
            recentTrend: {
                last30Days: recentRatings.length,
                averageLast30Days: recentRatings.length > 0 
                    ? parseFloat((recentRatings.reduce((sum, r) => sum + r.rating, 0) / recentRatings.length).toFixed(2))
                    : 0
            }
        };

        // Cache for 30 minutes (stats don't change frequently)
        await setCache(cacheKey, statsData, 1800);

        res.status(200).json({
            success: true,
            data: statsData
        });

    } catch (error) {
        console.error('Get rating stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/freelancer/meetings - Get all meetings for freelancer
flRouter.get('/meetings', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { status, page = 1, limit = 10 } = req.query;

        const cacheKey = `freelancer:meetings:${userId}:status:${status || 'all'}:page:${page}:limit:${limit}`;
        
        const cachedMeetings = await getCache(cacheKey);
        if (cachedMeetings) {
            return res.status(200).json({
                success: true,
                data: cachedMeetings,
                cached: true
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const freelancer = await prisma.freelancer.findUnique({
            where: { userId }
        });

        if (!freelancer) {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
            });
        }

        const whereClause = {
            freelancerId: freelancer.id
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
                            description: true,
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
        console.error('Get freelancer meetings error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// PUT /api/freelancer/meetings/:meetingId/request-reschedule - Request meeting reschedule
flRouter.put('/meetings/:meetingId/request-reschedule', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { meetingId } = req.params;
        const { rescheduleReason, suggestedDates } = req.body;

        if (!rescheduleReason) {
            return res.status(400).json({
                success: false,
                message: 'Reschedule reason is required'
            });
        }

        const freelancer = await prisma.freelancer.findUnique({
            where: { userId }
        });

        if (!freelancer) {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
            });
        }

        const meeting = await prisma.meeting.findFirst({
            where: {
                id: meetingId,
                freelancerId: freelancer.id
            }
        });

        if (!meeting) {
            return res.status(404).json({
                success: false,
                message: 'Meeting not found'
            });
        }

        // Update meeting with reschedule request
        const updatedMeeting = await prisma.meeting.update({
            where: { id: meetingId },
            data: {
                notes: `${meeting.notes || ''}\n\nFreelancer Reschedule Request: ${rescheduleReason}${suggestedDates ? `\nSuggested Dates: ${suggestedDates}` : ''}`
            }
        });

        res.status(200).json({
            success: true,
            message: 'Reschedule request sent to client',
            data: updatedMeeting
        });

    } catch (error) {
        console.error('Request reschedule error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// POST /api/freelancer/projects/:projectId/meetings/request - Request a meeting with client
flRouter.post('/projects/:projectId/meetings/request', authenticateToken, checkFreelancerActive, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId } = req.params;
        const { 
            requestReason,
            suggestedDates, // Array of suggested dates/times
            meetingType = 'GENERAL', // CLARIFICATION, PROGRESS_UPDATE, ISSUE_DISCUSSION, GENERAL
            urgency = 'NORMAL', // LOW, NORMAL, HIGH, URGENT
            description,
            preferredDuration = 30
        } = req.body;

        // Validation
        if (!requestReason) {
            return res.status(400).json({
                success: false,
                message: 'Meeting request reason is required'
            });
        }

        // Use freelancer from middleware
        const freelancer = req.freelancer;

        // Check if project exists and is assigned to this freelancer
        const project = await prisma.project.findFirst({
            where: {
                id: projectId,
                assignedTo: freelancer.id,
                status: { in: ['ASSIGNED', 'PENDING_COMPLETION'] }
            },
            include: {
                client: {
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
                message: 'Project not found, not assigned to you, or not in correct status'
            });
        }

        // Check if client is still active
        if (!project.client.user.isActive) {
            return res.status(400).json({
                success: false,
                message: 'Cannot request meeting. Client account is inactive.'
            });
        }

        // Get the application for this project
        const application = await prisma.application.findFirst({
            where: {
                projectId,
                freelancerId: freelancer.id,
                status: 'APPROVED'
            }
        });

        if (!application) {
            return res.status(400).json({
                success: false,
                message: 'No approved application found for this project'
            });
        }

        // Create meeting request entry
        const meetingRequest = await prisma.meetingRequest.create({
            data: {
                projectId,
                applicationId: application.id,
                requesterId: userId,
                requesterType: 'FREELANCER',
                clientId: project.client.id,
                freelancerId: freelancer.id,
                requestReason,
                meetingType,
                urgency,
                description: description || `${meetingType} meeting requested for project: ${project.title}`,
                suggestedDates: suggestedDates || [],
                preferredDuration: parseInt(preferredDuration),
                status: 'PENDING'
            },
            include: {
                project: {
                    select: {
                        title: true,
                        description: true,
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
        });

        // Invalidate client dashboard cache (new meeting request)
        const cacheKeysToDelete = [
            `client:dashboard:${project.client.user.id}`,
            `freelancer:dashboard:${userId}`
        ];

        // Clear meeting request caches
        for (let page = 1; page <= 10; page++) {
            for (let limit of [10, 20, 50]) {
                cacheKeysToDelete.push(
                    `client:meeting-requests:${project.client.user.id}:status:all:page:${page}:limit:${limit}`,
                    `client:meeting-requests:${project.client.user.id}:status:PENDING:page:${page}:limit:${limit}`,
                    `freelancer:meeting-requests:${userId}:status:all:page:${page}:limit:${limit}`,
                    `freelancer:meeting-requests:${userId}:status:PENDING:page:${page}:limit:${limit}`
                );
            }
        }

        await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));

        res.status(201).json({
            success: true,
            message: 'Meeting request sent to client successfully',
            data: meetingRequest
        });

    } catch (error) {
        console.error('Request meeting error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/freelancer/meeting-requests - Get all meeting requests made by freelancer
flRouter.get('/meeting-requests', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { status, page = 1, limit = 10 } = req.query;

        const cacheKey = `freelancer:meeting-requests:${userId}:status:${status || 'all'}:page:${page}:limit:${limit}`;
        
        const cachedRequests = await getCache(cacheKey);
        if (cachedRequests) {
            return res.status(200).json({
                success: true,
                data: cachedRequests,
                cached: true
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const freelancer = await prisma.freelancer.findUnique({
            where: { userId }
        });

        if (!freelancer) {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
            });
        }

        const whereClause = {
            requesterId: userId,
            requesterType: 'FREELANCER'
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
                            description: true,
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
                orderBy: {
                    createdAt: 'desc'
                },
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

// GET /api/freelancer/projects/:projectId/meetings - Get all meetings for a specific project
flRouter.get('/projects/:projectId/meetings', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId } = req.params;
        const { status, page = 1, limit = 10 } = req.query;

        const cacheKey = `freelancer:project:${projectId}:meetings:status:${status || 'all'}:page:${page}:limit:${limit}`;
        
        const cachedMeetings = await getCache(cacheKey);
        if (cachedMeetings) {
            return res.status(200).json({
                success: true,
                data: cachedMeetings,
                cached: true
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const freelancer = await prisma.freelancer.findUnique({
            where: { userId }
        });

        if (!freelancer) {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
            });
        }

        // Verify project is assigned to freelancer
        const project = await prisma.project.findFirst({
            where: {
                id: projectId,
                assignedTo: freelancer.id
            }
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found or not assigned to you'
            });
        }

        const whereClause = {
            projectId,
            freelancerId: freelancer.id
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
                            description: true,
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
        console.error('Get freelancer project meetings error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// Error handling middleware for multer
flRouter.use((error, req, res, next) => {
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

// GET /api/freelancer/applications/:applicationId/meetings - Get meetings for specific application (freelancer view)
flRouter.get('/applications/:applicationId/meetings', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { applicationId } = req.params;
        const { status, page = 1, limit = 10 } = req.query;

        const cacheKey = `freelancer:application:${applicationId}:meetings:status:${status || 'all'}:page:${page}:limit:${limit}`;
        
        const cachedMeetings = await getCache(cacheKey);
        if (cachedMeetings) {
            return res.status(200).json({
                success: true,
                data: cachedMeetings,
                cached: true
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const freelancer = await prisma.freelancer.findUnique({
            where: { userId }
        });

        if (!freelancer) {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found'
            });
        }

        // Verify application belongs to freelancer
        const application = await prisma.application.findFirst({
            where: {
                id: applicationId,
                freelancerId: freelancer.id
            },
            include: {
                project: {
                    select: {
                        title: true,
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
        });

        if (!application) {
            return res.status(404).json({
                success: false,
                message: 'Application not found or not yours'
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
                project: application.project
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
        console.error('Get freelancer application meetings error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});
// Add this helper function at the top of freelancer.js after imports

const invalidateFreelancerCaches = async (userId, freelancerId = null) => {
    const cacheKeysToDelete = [
        // Freelancer specific caches
        `freelancer:profile:${userId}`,
        `freelancer:dashboard:${userId}`,
        
        // Public caches
        'public:projects:available',
        'public:projects:recent',
        'public:featured:freelancers',
        'admin:dashboard:stats'
    ];

    // Add application-related caches with different filters
    const statuses = ['all', 'PENDING', 'APPROVED', 'REJECTED'];
    const pages = Array.from({length: 5}, (_, i) => i + 1);
    const limits = [10, 20, 50];

    for (const status of statuses) {
        for (const page of pages) {
            for (const limit of limits) {
                cacheKeysToDelete.push(
                    `freelancer:applications:${userId}:status:${status}:page:${page}:limit:${limit}`,
                    `freelancer:projects:${userId}:status:${status}:page:${page}:limit:${limit}`,
                    `freelancer:available:projects:${userId}:page:${page}:limit:${limit}`
                );
            }
        }
    }

    // Delete all caches
    await Promise.all(cacheKeysToDelete.map(key => deleteCache(key)));
};




