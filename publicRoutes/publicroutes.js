import { Router } from "express";
import prisma from "../prisma.config.js";
import { setCache, getCache } from "../utils/redis.js";

export const publicRouter = Router();

// GET /api/public/freelancers - Get all freelancer profiles with project details
publicRouter.get('/freelancers', async (req, res) => {
    try {
        const {
            skills,
            minRating,
            location,
            availability,
            page = 1,
            limit = 12
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const cacheKey = `public:freelancers:${JSON.stringify(req.query)}`;

        // Check cache
        const cachedData = await getCache(cacheKey);
        if (cachedData) {
            return res.status(200).json({
                success: true,
                data: cachedData
            });
        }

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
        if (location) {
            whereClause.user = {
                location: {
                    contains: location,
                    mode: 'insensitive'
                }
            };
        }

        // Add to whereClause
        whereClause.user = {
            ...whereClause.user,
            isActive: true // Only show active freelancers
        };

        const freelancers = await prisma.freelancer.findMany({
            where: whereClause,
            include: {
                user: {
                    select: {
                        name: true,
                        profileImage: true,
                        bio: true,
                        location: true,
                        createdAt: true
                    }
                },
                assignedProjects: {
                    where: {
                        status: 'COMPLETED'
                    },
                    select: {
                        id: true,
                        title: true,
                        createdAt: true,
                        client: {
                            select: {
                                companyName: true,
                                user: {
                                    select: {
                                        name: true
                                    }
                                }
                            }
                        }
                    },
                    orderBy: {
                        createdAt: 'desc'
                    }
                }
            },
            orderBy: [
                { ratings: 'desc' },
                { projectsCompleted: 'desc' }
            ],
            skip,
            take: parseInt(limit)
        });

        const totalFreelancers = await prisma.freelancer.count({
            where: whereClause
        });

        const responseData = {
            freelancers: freelancers.map(freelancer => ({
                id: freelancer.id,
                profile: {
                    name: freelancer.user.name,
                    profileImage: freelancer.user.profileImage,
                    bio: freelancer.user.bio,
                    location: freelancer.user.location,
                    memberSince: freelancer.user.createdAt
                },
                skills: freelancer.skills,
                experience: freelancer.experience,
                projectsCompleted: freelancer.projectsCompleted,
                ratings: freelancer.ratings,
                hourlyRate: freelancer.hourlyRate,
                availability: freelancer.availability,
                portfolioLinks: {
                    github: freelancer.githubUrl,
                    linkedin: freelancer.linkedinUrl,
                    portfolio: freelancer.portfolioUrl
                },
                completedProjects: freelancer.assignedProjects.map(project => ({
                    title: project.title,
                    completedAt: project.createdAt,
                    client: {
                        name: project.client.user.name,
                        company: project.client.companyName
                    }
                }))
            })),
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalFreelancers,
                pages: Math.ceil(totalFreelancers / parseInt(limit))
            }
        };

        // Cache for 10 minutes
        await setCache(cacheKey, responseData, 600);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get public freelancers error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/public/jobs - Get all available jobs/projects
publicRouter.get('/jobs', async (req, res) => {
    try {
        const {
            skills,
            budgetMin,
            budgetMax,
            duration,
            page = 1,
            limit = 12
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const cacheKey = `public:jobs:${JSON.stringify(req.query)}`;

        // Check cache
        const cachedData = await getCache(cacheKey);
        if (cachedData) {
            return res.status(200).json({
                success: true,
                data: cachedData
            });
        }

        const whereClause = {
            status: 'OPEN',
            client: {
                user: {
                    isActive: true // Only show projects from active clients
                }
            }
        };

        // Filter by skills
        if (skills) {
            const skillsArray = skills.split(',').map(skill => skill.trim());
            whereClause.skillsRequired = {
                hasSome: skillsArray
            };
        }

        // Filter by budget range
        if (budgetMin) {
            whereClause.budgetMin = { gte: parseFloat(budgetMin) };
        }
        if (budgetMax) {
            whereClause.budgetMax = { lte: parseFloat(budgetMax) };
        }

        // Filter by duration
        if (duration) {
            whereClause.duration = {
                contains: duration,
                mode: 'insensitive'
            };
        }

        const projects = await prisma.project.findMany({
            where: whereClause,
            include: {
                client: {
                    select: {
                        companyName: true,
                        industry: true,
                        ratings: true,
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
                    select: {
                        id: true
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

        const responseData = {
            jobs: projects.map(project => ({
                id: project.id,
                title: project.title,
                description: project.description,
                skillsRequired: project.skillsRequired,
                budget: {
                    min: project.budgetMin,
                    max: project.budgetMax
                },
                duration: project.duration,
                postedAt: project.createdAt,
                applicationsCount: project.applications.length,
                client: {
                    name: project.client.user.name,
                    company: project.client.companyName,
                    industry: project.client.industry,
                    location: project.client.user.location,
                    profileImage: project.client.user.profileImage,
                    ratings: project.client.ratings
                }
            })),
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalProjects,
                pages: Math.ceil(totalProjects / parseInt(limit))
            }
        };

        // Cache for 5 minutes
        await setCache(cacheKey, responseData, 300);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get public jobs error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/public/featured/projects - Get top 3 featured projects
publicRouter.get('/featured/projects', async (req, res) => {
    try {
        const cacheKey = 'public:featured:projects';

        // Check cache
        const cachedData = await getCache(cacheKey);
        if (cachedData) {
            return res.status(200).json({
                success: true,
                data: cachedData
            });
        }

        // Get projects with most applications (indicating popularity)
        const featuredProjects = await prisma.project.findMany({
            where: {
                status: 'OPEN'
            },
            include: {
                client: {
                    select: {
                        companyName: true,
                        industry: true,
                        ratings: true,
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
                    select: {
                        id: true,
                        freelancer: {
                            select: {
                                ratings: true
                            }
                        }
                    }
                }
            },
            orderBy: {
                createdAt: 'desc'
            },
            take: 10 // Get more to filter and randomize
        });

        // Sort by applications count and randomize if tied
        const sortedProjects = featuredProjects
            .map(project => ({
                ...project,
                applicationsCount: project.applications.length,
                averageFreelancerRating: project.applications.length > 0
                    ? project.applications.reduce((sum, app) => sum + app.freelancer.ratings, 0) / project.applications.length
                    : 0
            }))
            .sort((a, b) => {
                if (b.applicationsCount === a.applicationsCount) {
                    return Math.random() - 0.5; // Random sort if tied
                }
                return b.applicationsCount - a.applicationsCount;
            })
            .slice(0, 3);

        const responseData = sortedProjects.map(project => ({
            id: project.id,
            title: project.title,
            description: project.description,
            skillsRequired: project.skillsRequired,
            budget: {
                min: project.budgetMin,
                max: project.budgetMax
            },
            duration: project.duration,
            postedAt: project.createdAt,
            applicationsCount: project.applicationsCount,
            averageFreelancerRating: project.averageFreelancerRating,
            client: {
                name: project.client.user.name,
                company: project.client.companyName,
                industry: project.client.industry,
                location: project.client.user.location,
                profileImage: project.client.user.profileImage,
                ratings: project.client.ratings
            }
        }));

        // Cache for 15 minutes
        await setCache(cacheKey, responseData, 900);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get featured projects error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/public/featured/freelancers - Get top 3 featured freelancers
publicRouter.get('/featured/freelancers', async (req, res) => {
    try {
        const cacheKey = 'public:featured:freelancers';

        // Check cache
        const cachedData = await getCache(cacheKey);
        if (cachedData) {
            return res.status(200).json({
                success: true,
                data: cachedData
            });
        }

        // Get freelancers ordered by projects completed and ratings
        const featuredFreelancers = await prisma.freelancer.findMany({
            where: {
                availability: true
            },
            include: {
                user: {
                    select: {
                        name: true,
                        profileImage: true,
                        bio: true,
                        location: true,
                        createdAt: true
                    }
                },
                assignedProjects: {
                    where: {
                        status: 'COMPLETED'
                    },
                    select: {
                        id: true,
                        title: true,
                        createdAt: true,
                        client: {
                            select: {
                                companyName: true,
                                user: {
                                    select: {
                                        name: true
                                    }
                                }
                            }
                        }
                    },
                    orderBy: {
                        createdAt: 'desc'
                    },
                    take: 5 // Show last 5 projects
                }
            },
            orderBy: [
                { projectsCompleted: 'desc' },
                { ratings: 'desc' }
            ],
            take: 10 // Get more to filter and randomize
        });

        // Randomize if tied in projects completed
        const sortedFreelancers = featuredFreelancers
            .sort((a, b) => {
                if (b.projectsCompleted === a.projectsCompleted) {
                    if (b.ratings === a.ratings) {
                        return Math.random() - 0.5; // Random sort if completely tied
                    }
                    return b.ratings - a.ratings;
                }
                return b.projectsCompleted - a.projectsCompleted;
            })
            .slice(0, 4);

        const responseData = sortedFreelancers.map(freelancer => ({
            id: freelancer.id,
            profile: {
                name: freelancer.user.name,
                profileImage: freelancer.user.profileImage,
                bio: freelancer.user.bio,
                location: freelancer.user.location,
                memberSince: freelancer.user.createdAt
            },
            skills: freelancer.skills,
            experience: freelancer.experience,
            projectsCompleted: freelancer.projectsCompleted,
            ratings: freelancer.ratings,
            hourlyRate: freelancer.hourlyRate,
            portfolioLinks: {
                github: freelancer.githubUrl,
                linkedin: freelancer.linkedinUrl,
                portfolio: freelancer.portfolioUrl
            },
            recentProjects: freelancer.assignedProjects.map(project => ({
                title: project.title,
                completedAt: project.createdAt,
                client: {
                    name: project.client.user.name,
                    company: project.client.companyName
                }
            }))
        }));

        // Cache for 15 minutes
        await setCache(cacheKey, responseData, 900);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get featured freelancers error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/public/stats - Get platform statistics
publicRouter.get('/stats', async (req, res) => {
    try {
        const cacheKey = 'public:platform:stats';

        // Check cache
        const cachedData = await getCache(cacheKey);
        if (cachedData) {
            return res.status(200).json({
                success: true,
                data: cachedData
            });
        }

        const [
            totalFreelancers,
            totalClients,
            totalProjects,
            completedProjects,
            openProjects
        ] = await Promise.all([
            prisma.freelancer.count(),
            prisma.client.count(),
            prisma.project.count(),
            prisma.project.count({ where: { status: 'COMPLETED' } }),
            prisma.project.count({ where: { status: 'OPEN' } })
        ]);

        const responseData = {
            totalFreelancers,
            totalClients,
            totalProjects,
            completedProjects,
            openProjects,
            successRate: totalProjects > 0 ? ((completedProjects / totalProjects) * 100).toFixed(1) : 0
        };

        // Cache for 30 minutes
        await setCache(cacheKey, responseData, 1800);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get platform stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/public/users/:userId/ratings - Get public ratings for any user (freelancer or client)
publicRouter.get('/users/:userId/ratings', async (req, res) => {
    try {
        const { userId } = req.params;
        const { page = 1, limit = 10 } = req.query;

        // Validate pagination parameters
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(50, Math.max(1, parseInt(limit))); // Max 50 items per page
        const skip = (pageNum - 1) * limitNum;

        // Create cache key
        const cacheKey = `public:user:${userId}:ratings:page:${pageNum}:limit:${limitNum}`;

        // Check cache first
        const cachedData = await getCache(cacheKey);
        if (cachedData) {
            return res.status(200).json({
                success: true,
                data: cachedData,
                cached: true
            });
        }

        // Check if user exists and get their basic info
        const user = await prisma.user.findUnique({
            where: {
                id: userId,
                isActive: true // Only show ratings for active users
            },
            select: {
                id: true,
                name: true,
                role: true,
                profileImage: true
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found or account is inactive'
            });
        }

        // Determine rating type based on user role
        let whereClause = {};
        let raterType = '';

        if (user.role === 'FREELANCER') {
            // For freelancers, show ratings received from clients
            whereClause = {
                ratedId: userId,
                raterType: 'CLIENT_TO_FREELANCER'
            };
            raterType = 'CLIENT_TO_FREELANCER';
        } else if (user.role === 'CLIENT') {
            // For clients, show ratings received from freelancers
            whereClause = {
                ratedId: userId,
                raterType: 'FREELANCER_TO_CLIENT'
            };
            raterType = 'FREELANCER_TO_CLIENT';
        } else {
            return res.status(400).json({
                success: false,
                message: 'Invalid user role for ratings'
            });
        }

        // Get ratings, total count, and statistics in parallel
        const [ratings, totalRatings, avgRatingData, ratingDistribution] = await Promise.all([
            // Get paginated ratings
            prisma.rating.findMany({
                where: whereClause,
                select: {
                    id: true,
                    rating: true,
                    review: true,
                    createdAt: true,
                    project: {
                        select: {
                            title: true
                        }
                    }
                },
                orderBy: {
                    createdAt: 'desc'
                },
                skip,
                take: limitNum
            }),

            // Get total count
            prisma.rating.count({
                where: whereClause
            }),

            // Get average rating
            prisma.rating.aggregate({
                where: whereClause,
                _avg: {
                    rating: true
                },
                _count: {
                    rating: true
                }
            }),

            // Get rating distribution
            prisma.rating.groupBy({
                by: ['rating'],
                where: whereClause,
                _count: {
                    rating: true
                }
            })
        ]);

        // Format ratings (remove rater information for privacy)
        const formattedRatings = ratings.map(rating => ({
            id: rating.id,
            rating: rating.rating,
            review: rating.review,
            project: {
                title: rating.project.title
            },
            createdAt: rating.createdAt
        }));

        // Create rating distribution object
        const distribution = {
            1: 0,
            2: 0,
            3: 0,
            4: 0,
            5: 0
        };

        ratingDistribution.forEach(item => {
            distribution[item.rating] = item._count.rating;
        });

        // Calculate additional statistics
        const averageRating = avgRatingData._avg.rating ? parseFloat(avgRatingData._avg.rating.toFixed(2)) : 0;
        const totalRatingsCount = avgRatingData._count.rating;

        // Calculate percentage for each rating
        const distributionWithPercentage = {};
        Object.keys(distribution).forEach(star => {
            const count = distribution[star];
            const percentage = totalRatingsCount > 0 ? ((count / totalRatingsCount) * 100).toFixed(1) : 0;
            distributionWithPercentage[star] = {
                count,
                percentage: parseFloat(percentage)
            };
        });

        const responseData = {
            user: {
                id: user.id,
                name: user.name,
                role: user.role,
                profileImage: user.profileImage
            },
            ratings: formattedRatings,
            statistics: {
                averageRating,
                totalRatings: totalRatingsCount,
                distribution: distributionWithPercentage,
                ratingBreakdown: {
                    excellent: distribution[5], // 5 star
                    good: distribution[4],      // 4 star
                    average: distribution[3],   // 3 star
                    poor: distribution[2],      // 2 star
                    terrible: distribution[1]   // 1 star
                }
            },
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: totalRatings,
                pages: Math.ceil(totalRatings / limitNum),
                hasNext: pageNum * limitNum < totalRatings,
                hasPrev: pageNum > 1
            }
        };

        // Cache for 20 minutes (public data, less frequent updates)
        await setCache(cacheKey, responseData, 1200);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get public user ratings error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/public/users/:userId/ratings/summary - Get condensed rating summary
publicRouter.get('/users/:userId/ratings/summary', async (req, res) => {
    try {
        const { userId } = req.params;
        const cacheKey = `public:user:${userId}:ratings:summary`;

        // Check cache first
        const cachedData = await getCache(cacheKey);
        if (cachedData) {
            return res.status(200).json({
                success: true,
                data: cachedData,
                cached: true
            });
        }

        // Check if user exists
        const user = await prisma.user.findUnique({
            where: {
                id: userId,
                isActive: true
            },
            select: {
                id: true,
                name: true,
                role: true,
                profileImage: true
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found or account is inactive'
            });
        }

        // Determine rating type based on user role
        let whereClause = {};
        if (user.role === 'FREELANCER') {
            whereClause = {
                ratedId: userId,
                raterType: 'CLIENT_TO_FREELANCER'
            };
        } else if (user.role === 'CLIENT') {
            whereClause = {
                ratedId: userId,
                raterType: 'FREELANCER_TO_CLIENT'
            };
        } else {
            return res.status(400).json({
                success: false,
                message: 'Invalid user role for ratings'
            });
        }

        // Get rating statistics and recent ratings
        const [avgRatingData, ratingDistribution, recentRatings] = await Promise.all([
            prisma.rating.aggregate({
                where: whereClause,
                _avg: {
                    rating: true
                },
                _count: {
                    rating: true
                }
            }),

            prisma.rating.groupBy({
                by: ['rating'],
                where: whereClause,
                _count: {
                    rating: true
                }
            }),

            // Get 3 most recent ratings
            prisma.rating.findMany({
                where: whereClause,
                select: {
                    rating: true,
                    review: true,
                    createdAt: true,
                    project: {
                        select: {
                            title: true
                        }
                    }
                },
                orderBy: {
                    createdAt: 'desc'
                },
                take: 3
            })
        ]);

        // Create rating distribution
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        ratingDistribution.forEach(item => {
            distribution[item.rating] = item._count.rating;
        });

        const averageRating = avgRatingData._avg.rating ? parseFloat(avgRatingData._avg.rating.toFixed(2)) : 0;
        const totalRatings = avgRatingData._count.rating;

        const responseData = {
            user: {
                id: user.id,
                name: user.name,
                role: user.role,
                profileImage: user.profileImage
            },
            summary: {
                averageRating,
                totalRatings,
                starDistribution: distribution,
                recentRatings: recentRatings.map(rating => ({
                    rating: rating.rating,
                    review: rating.review ? rating.review.substring(0, 100) + (rating.review.length > 100 ? '...' : '') : null,
                    projectTitle: rating.project.title,
                    createdAt: rating.createdAt
                }))
            }
        };

        // Cache for 30 minutes (summary data)
        await setCache(cacheKey, responseData, 1800);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get user ratings summary error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/public/freelancers/:freelancerId/profile - Get detailed freelancer public profile with client reviews
publicRouter.get('/freelancers/:freelancerId/profile', async (req, res) => {
    try {
        const { freelancerId } = req.params;
        const cacheKey = `public:freelancer:profile:${freelancerId}`;

        // Check cache first
        const cachedProfile = await getCache(cacheKey);
        if (cachedProfile) {
            return res.status(200).json({
                success: true,
                data: cachedProfile,
                cached: true
            });
        }

        // Get freelancer with all related data
        const freelancer = await prisma.freelancer.findUnique({
            where: {
                id: freelancerId,
                user: {
                    isActive: true // Only show active freelancers
                }
            },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        profileImage: true,
                        bio: true,
                        location: true,
                        createdAt: true
                    }
                },
                // Completed projects assigned to this freelancer
                assignedProjects: {
                    where: {
                        status: 'COMPLETED'
                    },
                    select: {
                        id: true,
                        title: true,
                        description: true,
                        skillsRequired: true,
                        budgetMin: true,
                        budgetMax: true,
                        duration: true,
                        createdAt: true,
                        updatedAt: true,
                        client: {
                            select: {
                                id: true,
                                companyName: true,
                                industry: true,
                                user: {
                                    select: {
                                        id: true,
                                        name: true,
                                        profileImage: true,
                                        location: true
                                    }
                                }
                            }
                        }
                    },
                    orderBy: {
                        updatedAt: 'desc'
                    },
                    take: 10 // Show latest 10 completed projects
                }
            }
        });

        if (!freelancer) {
            return res.status(404).json({
                success: false,
                message: 'Freelancer not found or account is inactive'
            });
        }

        // Get ratings received by this freelancer (from clients) with client details
        const [ratingsWithClientDetails, ratingStats, ratingDistribution] = await Promise.all([
            // Get ratings with client information
            prisma.rating.findMany({
                where: {
                    ratedId: freelancer.user.id,
                    raterType: 'CLIENT_TO_FREELANCER'
                },
                select: {
                    id: true,
                    rating: true,
                    review: true,
                    createdAt: true,
                    raterId: true, // Client user ID
                    project: {
                        select: {
                            id: true,
                            title: true,
                            client: {
                                select: {
                                    id: true,
                                    companyName: true,
                                    industry: true,
                                    isVerified: true,
                                    user: {
                                        select: {
                                            id: true,
                                            name: true,
                                            profileImage: true,
                                            location: true
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
                take: 20 // Show more ratings for better overview
            }),

            // Rating statistics
            prisma.rating.aggregate({
                where: {
                    ratedId: freelancer.user.id,
                    raterType: 'CLIENT_TO_FREELANCER'
                },
                _avg: {
                    rating: true
                },
                _count: {
                    rating: true
                }
            }),

            // Rating distribution
            prisma.rating.groupBy({
                by: ['rating'],
                where: {
                    ratedId: freelancer.user.id,
                    raterType: 'CLIENT_TO_FREELANCER'
                },
                _count: {
                    rating: true
                }
            })
        ]);

        // Create rating distribution object
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        ratingDistribution.forEach(item => {
            distribution[item.rating] = item._count.rating;
        });

        // Calculate additional metrics
        const totalProjectsValue = freelancer.assignedProjects.reduce((sum, project) => {
            return sum + (project.budgetMax || project.budgetMin || 0);
        }, 0);

        const averageProjectDuration = freelancer.assignedProjects.length > 0 ?
            freelancer.assignedProjects.reduce((sum, project) => {
                const startDate = new Date(project.createdAt);
                const endDate = new Date(project.updatedAt);
                const durationDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
                return sum + durationDays;
            }, 0) / freelancer.assignedProjects.length : 0;

        // Group ratings by rating value for better display
        const ratingsByValue = {
            5: ratingsWithClientDetails.filter(r => r.rating === 5),
            4: ratingsWithClientDetails.filter(r => r.rating === 4),
            3: ratingsWithClientDetails.filter(r => r.rating === 3),
            2: ratingsWithClientDetails.filter(r => r.rating === 2),
            1: ratingsWithClientDetails.filter(r => r.rating === 1)
        };

        // Calculate rating percentages
        const totalRatings = ratingsWithClientDetails.length;
        const ratingPercentages = {};
        Object.keys(distribution).forEach(star => {
            const count = distribution[star];
            ratingPercentages[star] = totalRatings > 0 ? ((count / totalRatings) * 100).toFixed(1) : 0;
        });

        const profileData = {
            freelancer: {
                id: freelancer.id,
                profile: {
                    name: freelancer.user.name,
                    profileImage: freelancer.user.profileImage,
                    bio: freelancer.user.bio,
                    location: freelancer.user.location,
                    memberSince: freelancer.user.createdAt
                },
                professionalInfo: {
                    skills: freelancer.skills,
                    experience: freelancer.experience,
                    hourlyRate: freelancer.hourlyRate,
                    availability: freelancer.availability,
                    isVerified: freelancer.isVerified
                },
                portfolioLinks: {
                    github: freelancer.githubUrl,
                    linkedin: freelancer.linkedinUrl,
                    portfolio: freelancer.portfolioUrl
                },
                statistics: {
                    projectsCompleted: freelancer.projectsCompleted,
                    averageRating: ratingStats._avg.rating ? parseFloat(ratingStats._avg.rating.toFixed(2)) : 0,
                    totalRatings: ratingStats._count.rating,
                    totalProjectsValue,
                    averageProjectDuration: Math.ceil(averageProjectDuration),
                    ratingDistribution: distribution,
                    ratingPercentages: ratingPercentages
                }
            },
            // Enhanced client reviews with full client details
            clientReviews: {
                total: ratingsWithClientDetails.length,
                breakdown: {
                    excellent: ratingsByValue[5].length, // 5 star
                    good: ratingsByValue[4].length,      // 4 star
                    average: ratingsByValue[3].length,   // 3 star
                    poor: ratingsByValue[2].length,      // 2 star
                    terrible: ratingsByValue[1].length   // 1 star
                },
                reviews: ratingsWithClientDetails.map(rating => ({
                    id: rating.id,
                    rating: rating.rating,
                    review: rating.review,
                    createdAt: rating.createdAt,
                    project: {
                        id: rating.project.id,
                        title: rating.project.title
                    },
                    client: {
                        id: rating.project.client.id,
                        name: rating.project.client.user.name,
                        profileImage: rating.project.client.user.profileImage,
                        location: rating.project.client.user.location,
                        companyName: rating.project.client.companyName,
                        industry: rating.project.client.industry,
                        isVerified: rating.project.client.isVerified
                    }
                }))
            },
            completedProjects: freelancer.assignedProjects.map(project => ({
                id: project.id,
                title: project.title,
                description: project.description.length > 200 ?
                    project.description.substring(0, 200) + '...' :
                    project.description,
                skillsRequired: project.skillsRequired,
                budget: {
                    min: project.budgetMin,
                    max: project.budgetMax
                },
                duration: project.duration,
                completedAt: project.updatedAt,
                client: {
                    id: project.client.id,
                    name: project.client.user.name,
                    company: project.client.companyName,
                    industry: project.client.industry,
                    location: project.client.user.location,
                    profileImage: project.client.user.profileImage
                }
            }))
        };

        // Cache for 30 minutes (profile data changes less frequently)
        await setCache(cacheKey, {
            email: freelancer.user.email,
            ...profileData
        }, 1800);

        res.status(200).json({
            success: true,
            data: {
                email: freelancer.user.email,
                ...profileData
            }
        });

    } catch (error) {
        console.error('Get freelancer public profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/public/clients/:clientId/profile - Get detailed client public profile
publicRouter.get('/clients/:clientId/profile', async (req, res) => {
    try {
        const { clientId } = req.params;
        const cacheKey = `public:client:profile:${clientId}`;

        console.log(`Fetching public client profile for ID: ${clientId}`);

        // Check cache first
        // const cachedProfile = await getCache(cacheKey);
        // if (cachedProfile) {
        //     return res.status(200).json({
        //         success: true,
        //         data: cachedProfile,
        //         cached: true
        //     });
        // }

        // Get client with all related data
        const client = await prisma.client.findUnique({
            where: {
                id: clientId,
                user: {
                    isActive: true // Only show active clients
                }
            },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        profileImage: true,
                        bio: true,
                        location: true,
                        createdAt: true
                    }
                },
                // Projects posted by this client
                projects: {
                    where: {
                        status: 'COMPLETED'
                    },
                    select: {
                        id: true,
                        title: true,
                        description: true,
                        skillsRequired: true,
                        budgetMin: true,
                        budgetMax: true,
                        duration: true,
                        createdAt: true,
                        updatedAt: true,
                        freelancer: {
                            select: {
                                user: {
                                    select: {
                                        name: true,
                                        profileImage: true
                                    }
                                },
                                skills: true,
                                experience: true,
                                ratings: true
                            }
                        }
                    },
                    orderBy: {
                        updatedAt: 'desc'
                    },
                    take: 10 // Show latest 10 completed projects
                }
            }
        });

        if (!client) {
            return res.status(404).json({
                success: false,
                message: 'Client not found or account is inactive'
            });
        }

        // Get ratings received by this client (from freelancers)
        const [ratingsReceived, ratingStats, ratingDistribution] = await Promise.all([
            // Latest 5 ratings received
            prisma.rating.findMany({
                where: {
                    ratedId: client.user.id,
                    raterType: 'FREELANCER_TO_CLIENT'
                },
                select: {
                    id: true,
                    rating: true,
                    review: true,
                    createdAt: true,
                    project: {
                        select: {
                            title: true
                        }
                    }
                },
                orderBy: {
                    createdAt: 'desc'
                },
                take: 5
            }),

            // Rating statistics
            prisma.rating.aggregate({
                where: {
                    ratedId: client.user.id,
                    raterType: 'FREELANCER_TO_CLIENT'
                },
                _avg: {
                    rating: true
                },
                _count: {
                    rating: true
                }
            }),

            // Rating distribution
            prisma.rating.groupBy({
                by: ['rating'],
                where: {
                    ratedId: client.user.id,
                    raterType: 'FREELANCER_TO_CLIENT'
                },
                _count: {
                    rating: true
                }
            })
        ]);

        // Create rating distribution object
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        ratingDistribution.forEach(item => {
            distribution[item.rating] = item._count.rating;
        });

        // Calculate additional metrics
        const totalProjectsValue = client.projects.reduce((sum, project) => {
            return sum + (project.budgetMax || project.budgetMin || 0);
        }, 0);

        const averageProjectBudget = client.projects.length > 0 ?
            totalProjectsValue / client.projects.length : 0;

        const mostUsedSkills = client.projects.reduce((skillMap, project) => {
            project.skillsRequired.forEach(skill => {
                skillMap[skill] = (skillMap[skill] || 0) + 1;
            });
            return skillMap;
        }, {});

        const topSkills = Object.entries(mostUsedSkills)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10)
            .map(([skill, count]) => ({ skill, projectCount: count }));

        const profileData = {
            client: {
                id: client.id,
                profile: {
                    name: client.user.name,
                    profileImage: client.user.profileImage,
                    bio: client.user.bio,
                    location: client.user.location,
                    memberSince: client.user.createdAt
                },
                companyInfo: {
                    companyName: client.companyName,
                    industry: client.industry,
                    companySize: client.companySize,
                    website: client.website,
                    isVerified: client.isVerified
                },
                statistics: {
                    projectsPosted: client.projectsPosted,
                    projectsCompleted: client.projects.length,
                    averageRating: ratingStats._avg.rating ? parseFloat(ratingStats._avg.rating.toFixed(2)) : 0,
                    totalRatings: ratingStats._count.rating,
                    totalProjectsValue,
                    averageProjectBudget: Math.ceil(averageProjectBudget),
                    ratingDistribution: distribution,
                    topSkillsHired: topSkills
                }
            },
            ratingsReceived: ratingsReceived.map(rating => ({
                id: rating.id,
                rating: rating.rating,
                review: rating.review,
                projectTitle: rating.project.title,
                createdAt: rating.createdAt
            })),
            completedProjects: client.projects.map(project => ({
                id: project.id,
                title: project.title,
                description: project.description.length > 200 ?
                    project.description.substring(0, 200) + '...' :
                    project.description,
                skillsRequired: project.skillsRequired,
                budget: {
                    min: project.budgetMin,
                    max: project.budgetMax
                },
                duration: project.duration,
                completedAt: project.updatedAt,
                freelancer: project.freelancer ? {
                    name: project.freelancer.user.name,
                    profileImage: project.freelancer.user.profileImage,
                    skills: project.freelancer.skills.slice(0, 5), // Show top 5 skills
                    experience: project.freelancer.experience,
                    rating: project.freelancer.ratings
                } : null
            }))
        };

        // Cache for 30 minutes (profile data changes less frequently)
        await setCache(cacheKey, profileData, 1800);

        res.status(200).json({
            success: true,
            data: profileData
        });

    } catch (error) {
        console.error('Get client public profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/public/users/:userId/profile - Get user profile by userId (auto-detect freelancer or client)
publicRouter.get('/users/:userId/profile', async (req, res) => {
    try {
        const { userId } = req.params;
        const cacheKey = `public:user:profile:${userId}`;

        // Check cache first
        // const cachedProfile = await getCache(cacheKey);
        // if (cachedProfile) {
        //     return res.status(200).json({
        //         success: true,
        //         data: cachedProfile,
        //         cached: true
        //     });
        // }

        // First, determine if user is freelancer or client
        const user = await prisma.user.findUnique({
            where: {
                id: userId,
                isActive: true
            },
            include: {
                freelancer: true,
                client: true
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found or account is inactive'
            });
        }

        let profileData;

        if (user.role === 'FREELANCER' && user.freelancer) {
            // Get freelancer profile data directly (don't use HTTP request)
            const freelancer = await prisma.freelancer.findUnique({
                where: {
                    id: user.freelancer.id,
                    user: {
                        isActive: true
                    }
                },
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,
                            profileImage: true,
                            bio: true,
                            location: true,
                            createdAt: true
                        }
                    },
                    assignedProjects: {
                        where: {
                            status: 'COMPLETED'
                        },
                        select: {
                            id: true,
                            title: true,
                            description: true,
                            skillsRequired: true,
                            budgetMin: true,
                            budgetMax: true,
                            duration: true,
                            createdAt: true,
                            updatedAt: true,
                            client: {
                                select: {
                                    companyName: true,
                                    industry: true,
                                    user: {
                                        select: {
                                            name: true,
                                            profileImage: true,
                                            location: true
                                        }
                                    }
                                }
                            }
                        },
                        orderBy: {
                            updatedAt: 'desc'
                        },
                        take: 10
                    }
                }
            });

            if (!freelancer) {
                return res.status(404).json({
                    success: false,
                    message: 'Freelancer profile not found'
                });
            }

            // Get ratings data
            const [ratingsReceived, ratingStats, ratingDistribution] = await Promise.all([
                prisma.rating.findMany({
                    where: {
                        ratedId: freelancer.user.id,
                        raterType: 'CLIENT_TO_FREELANCER'
                    },
                    select: {
                        id: true,
                        rating: true,
                        review: true,
                        createdAt: true,
                        project: {
                            select: {
                                title: true
                            }
                        }
                    },
                    orderBy: {
                        createdAt: 'desc'
                    },
                    take: 5
                }),

                prisma.rating.aggregate({
                    where: {
                        ratedId: freelancer.user.id,
                        raterType: 'CLIENT_TO_FREELANCER'
                    },
                    _avg: {
                        rating: true
                    },
                    _count: {
                        rating: true
                    }
                }),

                prisma.rating.groupBy({
                    by: ['rating'],
                    where: {
                        ratedId: freelancer.user.id,
                        raterType: 'CLIENT_TO_FREELANCER'
                    },
                    _count: {
                        rating: true
                    }
                })
            ]);

            // Create rating distribution
            const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
            ratingDistribution.forEach(item => {
                distribution[item.rating] = item._count.rating;
            });

            // Calculate metrics
            const totalProjectsValue = freelancer.assignedProjects.reduce((sum, project) => {
                return sum + (project.budgetMax || project.budgetMin || 0);
            }, 0);

            const averageProjectDuration = freelancer.assignedProjects.length > 0 ?
                freelancer.assignedProjects.reduce((sum, project) => {
                    const startDate = new Date(project.createdAt);
                    const endDate = new Date(project.updatedAt);
                    const durationDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
                    return sum + durationDays;
                }, 0) / freelancer.assignedProjects.length : 0;

            profileData = {
                userType: 'FREELANCER',
                freelancer: {
                    id: freelancer.id,
                    profile: {
                        name: freelancer.user.name,
                        profileImage: freelancer.user.profileImage,
                        bio: freelancer.user.bio,
                        location: freelancer.user.location,
                        memberSince: freelancer.user.createdAt
                    },
                    professionalInfo: {
                        skills: freelancer.skills,
                        experience: freelancer.experience,
                        hourlyRate: freelancer.hourlyRate,
                        availability: freelancer.availability,
                        isVerified: freelancer.isVerified
                    },
                    portfolioLinks: {
                        github: freelancer.githubUrl,
                        linkedin: freelancer.linkedinUrl,
                        portfolio: freelancer.portfolioUrl
                    },
                    statistics: {
                        projectsCompleted: freelancer.projectsCompleted,
                        averageRating: ratingStats._avg.rating ? parseFloat(ratingStats._avg.rating.toFixed(2)) : 0,
                        totalRatings: ratingStats._count.rating,
                        totalProjectsValue,
                        averageProjectDuration: Math.ceil(averageProjectDuration),
                        ratingDistribution: distribution
                    }
                },
                ratingsReceived: ratingsReceived.map(rating => ({
                    id: rating.id,
                    rating: rating.rating,
                    review: rating.review,
                    projectTitle: rating.project.title,
                    createdAt: rating.createdAt
                })),
                completedProjects: freelancer.assignedProjects.map(project => ({
                    id: project.id,
                    title: project.title,
                    description: project.description.length > 200 ?
                        project.description.substring(0, 200) + '...' :
                        project.description,
                    skillsRequired: project.skillsRequired,
                    budget: {
                        min: project.budgetMin,
                        max: project.budgetMax
                    },
                    duration: project.duration,
                    completedAt: project.updatedAt,
                    client: {
                        name: project.client.user.name,
                        company: project.client.companyName,
                        industry: project.client.industry,
                        location: project.client.user.location,
                        profileImage: project.client.user.profileImage
                    }
                }))
            };
            await setCache(cacheKey, { email: freelancer.user.email, freelancer: profileData.freelancer }, 1800);

            res.status(200).json({
                success: true,
                data: { email: freelancer.user.email, freelancer: profileData.freelancer }
            });

        } else if (user.role === 'CLIENT' && user.client) {
            // Get client profile data directly (don't use HTTP request)
            const client = await prisma.client.findUnique({
                where: {
                    id: user.client.id,
                    user: {
                        isActive: true
                    }
                },
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,
                            profileImage: true,
                            bio: true,
                            location: true,
                            createdAt: true,
                            email: true
                        }
                    },
                    projects: {
                        where: {
                            status: 'COMPLETED'
                        },
                        select: {
                            id: true,
                            title: true,
                            description: true,
                            skillsRequired: true,
                            budgetMin: true,
                            budgetMax: true,
                            duration: true,
                            createdAt: true,
                            updatedAt: true,
                            freelancer: {
                                select: {
                                    user: {
                                        select: {
                                            name: true,
                                            profileImage: true
                                        }
                                    },
                                    skills: true,
                                    experience: true,
                                    ratings: true
                                }
                            }
                        },
                        orderBy: {
                            updatedAt: 'desc'
                        },
                        take: 10
                    }
                }
            });

            if (!client) {
                return res.status(404).json({
                    success: false,
                    message: 'Client profile not found'
                });
            }

            // Get ratings data for client
            const [ratingsReceived, ratingStats, ratingDistribution] = await Promise.all([
                prisma.rating.findMany({
                    where: {
                        ratedId: client.user.id,
                        raterType: 'FREELANCER_TO_CLIENT'
                    },
                    select: {
                        id: true,
                        rating: true,
                        review: true,
                        createdAt: true,
                        project: {
                            select: {
                                title: true
                            }
                        }
                    },
                    orderBy: {
                        createdAt: 'desc'
                    },
                    take: 5
                }),

                prisma.rating.aggregate({
                    where: {
                        ratedId: client.user.id,
                        raterType: 'FREELANCER_TO_CLIENT'
                    },
                    _avg: {
                        rating: true
                    },
                    _count: {
                        rating: true
                    }
                }),

                prisma.rating.groupBy({
                    by: ['rating'],
                    where: {
                        ratedId: client.user.id,
                        raterType: 'FREELANCER_TO_CLIENT'
                    },
                    _count: {
                        rating: true
                    }
                })
            ]);

            // Create rating distribution
            const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
            ratingDistribution.forEach(item => {
                distribution[item.rating] = item._count.rating;
            });

            // Calculate metrics
            const totalProjectsValue = client.projects.reduce((sum, project) => {
                return sum + (project.budgetMax || project.budgetMin || 0);
            }, 0);

            const averageProjectBudget = client.projects.length > 0 ?
                totalProjectsValue / client.projects.length : 0;

            const mostUsedSkills = client.projects.reduce((skillMap, project) => {
                project.skillsRequired.forEach(skill => {
                    skillMap[skill] = (skillMap[skill] || 0) + 1;
                });
                return skillMap;
            }, {});

            const topSkills = Object.entries(mostUsedSkills)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 10)
                .map(([skill, count]) => ({ skill, projectCount: count }));

            profileData = {
                userType: 'CLIENT',
                client: {
                    id: client.id,
                    profile: {
                        name: client.user.name,
                        profileImage: client.user.profileImage,
                        bio: client.user.bio,
                        location: client.user.location,
                        memberSince: client.user.createdAt
                    },
                    companyInfo: {
                        companyName: client.companyName,
                        industry: client.industry,
                        companySize: client.companySize,
                        website: client.website,
                        isVerified: client.isVerified
                    },
                    statistics: {
                        projectsPosted: client.projectsPosted,
                        projectsCompleted: client.projects.length,
                        averageRating: ratingStats._avg.rating ? parseFloat(ratingStats._avg.rating.toFixed(2)) : 0,
                        totalRatings: ratingStats._count.rating,
                        totalProjectsValue,
                        averageProjectBudget: Math.ceil(averageProjectBudget),
                        ratingDistribution: distribution,
                        topSkillsHired: topSkills
                    }
                },
                ratingsReceived: ratingsReceived.map(rating => ({
                    id: rating.id,
                    rating: rating.rating,
                    review: rating.review,
                    projectTitle: rating.project.title,
                    createdAt: rating.createdAt
                })),
                completedProjects: client.projects.map(project => ({
                    id: project.id,
                    title: project.title,
                    description: project.description.length > 200 ?
                        project.description.substring(0, 200) + '...' :
                        project.description,
                    skillsRequired: project.skillsRequired,
                    budget: {
                        min: project.budgetMin,
                        max: project.budgetMax
                    },
                    duration: project.duration,
                    completedAt: project.updatedAt,
                    freelancer: project.freelancer ? {
                        name: project.freelancer.user.name,
                        profileImage: project.freelancer.user.profileImage,
                        skills: project.freelancer.skills.slice(0, 5),
                        experience: project.freelancer.experience,
                        rating: project.freelancer.ratings
                    } : null
                }))
            };
            await setCache(cacheKey, { email: client.user.email, client: profileData.client }, 1800);

            res.status(200).json({
                success: true,
                data: { email: client.user.email, client: profileData.client }
            });

        } else {
            return res.status(400).json({
                success: false,
                message: 'Invalid user type or incomplete profile'
            });
        }

        // Cache for 30 minutes


    } catch (error) {
        console.error('Get user profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

// GET /api/public/profiles/search - Search across both freelancers and clients
publicRouter.get('/profiles/search', async (req, res) => {
    try {
        const {
            query,
            type, // 'freelancer', 'client', or 'all'
            skills,
            location,
            minRating,
            page = 1,
            limit = 12
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const cacheKey = `public:profiles:search:${JSON.stringify(req.query)}`;

        // Check cache
        const cachedResults = await getCache(cacheKey);
        if (cachedResults) {
            return res.status(200).json({
                success: true,
                data: cachedResults,
                cached: true
            });
        }

        const results = {};

        // Search freelancers
        if (!type || type === 'all' || type === 'freelancer') {
            const freelancerWhere = {
                user: {
                    isActive: true,
                    ...(query && {
                        OR: [
                            { name: { contains: query, mode: 'insensitive' } },
                            { bio: { contains: query, mode: 'insensitive' } }
                        ]
                    }),
                    ...(location && {
                        location: { contains: location, mode: 'insensitive' }
                    })
                },
                ...(skills && {
                    skills: {
                        hasSome: skills.split(',').map(s => s.trim())
                    }
                }),
                ...(minRating && {
                    ratings: { gte: parseFloat(minRating) }
                })
            };

            const freelancers = await prisma.freelancer.findMany({
                where: freelancerWhere,
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,
                            profileImage: true,
                            bio: true,
                            location: true,
                            createdAt: true
                        }
                    }
                },
                orderBy: [
                    { ratings: 'desc' },
                    { projectsCompleted: 'desc' }
                ],
                skip: type === 'freelancer' ? skip : 0,
                take: type === 'freelancer' ? parseInt(limit) : 6
            });

            results.freelancers = freelancers.map(freelancer => ({
                id: freelancer.id,
                userId: freelancer.user.id,
                type: 'FREELANCER',
                profile: {
                    name: freelancer.user.name,
                    profileImage: freelancer.user.profileImage,
                    bio: freelancer.user.bio,
                    location: freelancer.user.location,
                    memberSince: freelancer.user.createdAt
                },
                skills: freelancer.skills,
                experience: freelancer.experience,
                hourlyRate: freelancer.hourlyRate,
                ratings: freelancer.ratings,
                projectsCompleted: freelancer.projectsCompleted,
                availability: freelancer.availability
            }));
        }

        // Search clients
        if (!type || type === 'all' || type === 'client') {
            const clientWhere = {
                user: {
                    isActive: true,
                    ...(query && {
                        OR: [
                            { name: { contains: query, mode: 'insensitive' } },
                            { bio: { contains: query, mode: 'insensitive' } }
                        ]
                    }),
                    ...(location && {
                        location: { contains: location, mode: 'insensitive' }
                    })
                },
                ...(query && {
                    OR: [
                        { companyName: { contains: query, mode: 'insensitive' } },
                        { industry: { contains: query, mode: 'insensitive' } }
                    ]
                }),
                ...(minRating && {
                    ratings: { gte: parseFloat(minRating) }
                })
            };

            const clients = await prisma.client.findMany({
                where: clientWhere,
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,
                            profileImage: true,
                            bio: true,
                            location: true,
                            createdAt: true
                        }
                    }
                },
                orderBy: [
                    { ratings: 'desc' },
                    { projectsPosted: 'desc' }
                ],
                skip: type === 'client' ? skip : 0,
                take: type === 'client' ? parseInt(limit) : 6
            });

            results.clients = clients.map(client => ({
                id: client.id,
                userId: client.user.id,
                type: 'CLIENT',
                profile: {
                    name: client.user.name,
                    profileImage: client.user.profileImage,
                    bio: client.user.bio,
                    location: client.user.location,
                    memberSince: client.user.createdAt
                },
                companyName: client.companyName,
                industry: client.industry,
                companySize: client.companySize,
                ratings: client.ratings,
                projectsPosted: client.projectsPosted,
                website: client.website
            }));
        }

        // Get total counts for pagination
        const totalCounts = {};
        if (type === 'freelancer' || !type || type === 'all') {
            totalCounts.freelancers = await prisma.freelancer.count({
                where: {
                    user: {
                        isActive: true,
                        ...(query && {
                            OR: [
                                { name: { contains: query, mode: 'insensitive' } },
                                { bio: { contains: query, mode: 'insensitive' } }
                            ]
                        }),
                        ...(location && {
                            location: { contains: location, mode: 'insensitive' }
                        })
                    },
                    ...(skills && {
                        skills: {
                            hasSome: skills.split(',').map(s => s.trim())
                        }
                    }),
                    ...(minRating && {
                        ratings: { gte: parseFloat(minRating) }
                    })
                }
            });
        }

        if (type === 'client' || !type || type === 'all') {
            totalCounts.clients = await prisma.client.count({
                where: {
                    user: {
                        isActive: true,
                        ...(query && {
                            OR: [
                                { name: { contains: query, mode: 'insensitive' } },
                                { bio: { contains: query, mode: 'insensitive' } }
                            ]
                        }),
                        ...(location && {
                            location: { contains: location, mode: 'insensitive' }
                        })
                    },
                    ...(query && {
                        OR: [
                            { companyName: { contains: query, mode: 'insensitive' } },
                            { industry: { contains: query, mode: 'insensitive' } }
                        ]
                    }),
                    ...(minRating && {
                        ratings: { gte: parseFloat(minRating) }
                    })
                }
            });
        }

        const responseData = {
            ...results,
            totalCounts,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalCounts.freelancers + totalCounts.clients || 0,
                pages: Math.ceil((totalCounts.freelancers + totalCounts.clients || 0) / parseInt(limit))
            },
            searchQuery: {
                query,
                type,
                skills: skills ? skills.split(',') : null,
                location,
                minRating
            }
        };

        // Cache for 15 minutes
        await setCache(cacheKey, responseData, 900);

        res.status(200).json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Search profiles error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});