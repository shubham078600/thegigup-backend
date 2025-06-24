import { createClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();
// Check if REDIS_URL exists
if (!process.env.REDIS_URL) {
    console.error('REDIS_URL environment variable is not set');
    process.exit(1);
}

const redisClient = createClient({
    url: process.env.REDIS_URL
});

redisClient.on('error', (err) => {
    console.error('Redis Client Error:', err);
});

redisClient.on('connect', () => {
    console.log('Redis client connected successfully');
});

export const connectRedis = async () => {
    if (!redisClient.isOpen) {
        await redisClient.connect();
    }
    return redisClient;
};

export default redisClient;


