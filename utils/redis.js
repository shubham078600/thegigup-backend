import { connectRedis } from "../redis.config.js";

let redisClient;

// Initialize Redis client
const initializeRedis = async () => {
    if (!redisClient) {
        redisClient = await connectRedis();
    }
    return redisClient;
};

// Set cache
export const setCache = async (key, value, ttl = 300) => {
    try {
        const client = await initializeRedis();
        await client.setEx(key, ttl, JSON.stringify(value));
    } catch (error) {
        console.error('Error setting cache:', error);
    }
};

// Get cache
export const getCache = async (key) => {
    try {
        const client = await initializeRedis();
        const cachedData = await client.get(key);
        return cachedData ? JSON.parse(cachedData) : null;
    } catch (error) {
        console.error('Error getting cache:', error);
        return null;
    }
};

// Delete cache
export const deleteCache = async (key) => {
    try {
        const client = await initializeRedis();
        await client.del(key);
    } catch (error) {
        console.error('Error deleting cache:', error);
    }
};