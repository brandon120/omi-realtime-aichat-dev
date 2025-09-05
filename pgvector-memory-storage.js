/**
 * PostgreSQL with pgvector Memory Storage Implementation
 * 
 * This is a Railway-optimized alternative to ChromaDB that uses PostgreSQL with the pgvector extension.
 * Railway provides excellent PostgreSQL support with pgvector pre-installed.
 * 
 * Benefits over ChromaDB:
 * - Native Railway support
 * - Better reliability and uptime
 * - ACID compliance
 * - Familiar SQL interface
 * - Better scaling options
 * - Lower cost
 * 
 * Setup:
 * 1. Add PostgreSQL service in Railway
 * 2. Enable pgvector extension
 * 3. Set DATABASE_URL environment variable
 * 4. Replace ChromaDB initialization with this module
 */

const { Pool } = require('pg');
const OpenAI = require('openai');

class PgVectorMemoryStorage {
    constructor() {
        this.pool = null;
        this.openai = null;
        this.isInitialized = false;
    }

    /**
     * Initialize the PostgreSQL connection and create necessary tables
     */
    async initialize() {
        try {
            // Create connection pool
            this.pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 2000,
            });

            // Test connection
            const client = await this.pool.connect();
            await client.query('SELECT NOW()');
            client.release();

            console.log('✅ PostgreSQL connection established');

            // Initialize OpenAI client
            if (process.env.OPENAI_KEY) {
                this.openai = new OpenAI({
                    apiKey: process.env.OPENAI_KEY,
                });
                console.log('✅ OpenAI client initialized');
            }

            // Create tables and extensions
            await this.createTables();
            
            this.isInitialized = true;
            console.log('✅ PgVector memory storage initialized');
            
        } catch (error) {
            console.error('❌ Failed to initialize PgVector storage:', error.message);
            throw error;
        }
    }

    /**
     * Create necessary tables and extensions
     */
    async createTables() {
        const client = await this.pool.connect();
        try {
            // Enable pgvector extension
            await client.query('CREATE EXTENSION IF NOT EXISTS vector');
            
            // Create memories table
            await client.query(`
                CREATE TABLE IF NOT EXISTS omi_memories (
                    id VARCHAR(255) PRIMARY KEY,
                    user_id VARCHAR(255) NOT NULL,
                    content TEXT NOT NULL,
                    category VARCHAR(100),
                    type VARCHAR(50) DEFAULT 'memory',
                    source VARCHAR(100),
                    metadata JSONB,
                    embedding vector(1536),
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                )
            `);

            // Create indexes for better performance
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_omi_memories_user_id ON omi_memories(user_id)
            `);
            
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_omi_memories_category ON omi_memories(category)
            `);
            
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_omi_memories_created_at ON omi_memories(created_at)
            `);

            // Create vector similarity search index
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_omi_memories_embedding 
                ON omi_memories USING ivfflat (embedding vector_cosine_ops)
                WITH (lists = 100)
            `);

            console.log('✅ Database tables and indexes created');
            
        } finally {
            client.release();
        }
    }

    /**
     * Generate embedding using OpenAI
     */
    async generateEmbedding(text) {
        if (!this.openai) {
            throw new Error('OpenAI client not initialized');
        }

        try {
            const response = await this.openai.embeddings.create({
                model: "text-embedding-3-small",
                input: text
            });
            return response.data[0].embedding;
        } catch (error) {
            console.error('❌ Error generating embedding:', error.message);
            throw error;
        }
    }

    /**
     * Add a memory to the database
     */
    async addMemory(memoryData) {
        if (!this.isInitialized) {
            throw new Error('PgVector storage not initialized');
        }

        const client = await this.pool.connect();
        try {
            // Generate embedding
            const embedding = await this.generateEmbedding(memoryData.content);

            // Insert memory
            await client.query(`
                INSERT INTO omi_memories (
                    id, user_id, content, category, type, source, 
                    metadata, embedding, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
                ON CONFLICT (id) DO UPDATE SET
                    content = EXCLUDED.content,
                    category = EXCLUDED.category,
                    type = EXCLUDED.type,
                    source = EXCLUDED.source,
                    metadata = EXCLUDED.metadata,
                    embedding = EXCLUDED.embedding,
                    updated_at = NOW()
            `, [
                memoryData.id,
                memoryData.userId,
                memoryData.content,
                memoryData.category || 'general',
                memoryData.type || 'memory',
                memoryData.source || 'conversation',
                JSON.stringify(memoryData.metadata || {}),
                `[${embedding.join(',')}]` // Convert array to PostgreSQL array format
            ]);

            console.log(`✅ Memory added: ${memoryData.id}`);
            
        } catch (error) {
            console.error('❌ Error adding memory:', error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Search memories using vector similarity
     */
    async searchMemories(userId, query, limit = 5) {
        if (!this.isInitialized) {
            throw new Error('PgVector storage not initialized');
        }

        const client = await this.pool.connect();
        try {
            // Generate query embedding
            const queryEmbedding = await this.generateEmbedding(query);

            // Search using vector similarity
            const result = await client.query(`
                SELECT 
                    id, user_id, content, category, type, source, 
                    metadata, created_at,
                    1 - (embedding <=> $1) as similarity
                FROM omi_memories 
                WHERE user_id = $2 
                ORDER BY embedding <=> $1
                LIMIT $3
            `, [
                `[${queryEmbedding.join(',')}]`,
                userId,
                limit
            ]);

            return result.rows.map(row => ({
                id: row.id,
                userId: row.user_id,
                content: row.content,
                category: row.category,
                type: row.type,
                source: row.source,
                metadata: row.metadata,
                timestamp: row.created_at.toISOString(),
                similarity: row.similarity
            }));

        } catch (error) {
            console.error('❌ Error searching memories:', error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get all memories for a user with filtering and pagination
     */
    async getAllMemories(userId, options = {}) {
        if (!this.isInitialized) {
            throw new Error('PgVector storage not initialized');
        }

        const {
            limit = 50,
            offset = 0,
            category = null,
            startDate = null,
            endDate = null,
            searchQuery = null
        } = options;

        const client = await this.pool.connect();
        try {
            let whereConditions = ['user_id = $1'];
            let queryParams = [userId];
            let paramIndex = 2;

            if (category) {
                whereConditions.push(`category = $${paramIndex}`);
                queryParams.push(category);
                paramIndex++;
            }

            if (startDate) {
                whereConditions.push(`created_at >= $${paramIndex}`);
                queryParams.push(startDate);
                paramIndex++;
            }

            if (endDate) {
                whereConditions.push(`created_at <= $${paramIndex}`);
                queryParams.push(endDate);
                paramIndex++;
            }

            if (searchQuery) {
                whereConditions.push(`content ILIKE $${paramIndex}`);
                queryParams.push(`%${searchQuery}%`);
                paramIndex++;
            }

            const whereClause = whereConditions.join(' AND ');

            // Get total count
            const countResult = await client.query(`
                SELECT COUNT(*) as total 
                FROM omi_memories 
                WHERE ${whereClause}
            `, queryParams);

            const total = parseInt(countResult.rows[0].total);

            // Get paginated results
            const result = await client.query(`
                SELECT 
                    id, user_id, content, category, type, source, 
                    metadata, created_at
                FROM omi_memories 
                WHERE ${whereClause}
                ORDER BY created_at DESC
                LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
            `, [...queryParams, limit, offset]);

            const memories = result.rows.map(row => ({
                id: row.id,
                userId: row.user_id,
                content: row.content,
                category: row.category,
                type: row.type,
                source: row.source,
                metadata: row.metadata,
                timestamp: row.created_at.toISOString()
            }));

            return {
                memories,
                total,
                limit,
                offset,
                hasMore: offset + limit < total
            };

        } catch (error) {
            console.error('❌ Error getting memories:', error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Delete a memory
     */
    async deleteMemory(memoryId) {
        if (!this.isInitialized) {
            throw new Error('PgVector storage not initialized');
        }

        const client = await this.pool.connect();
        try {
            const result = await client.query(
                'DELETE FROM omi_memories WHERE id = $1',
                [memoryId]
            );

            return result.rowCount > 0;
        } catch (error) {
            console.error('❌ Error deleting memory:', error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get memory by ID
     */
    async getMemoryById(memoryId) {
        if (!this.isInitialized) {
            throw new Error('PgVector storage not initialized');
        }

        const client = await this.pool.connect();
        try {
            const result = await client.query(`
                SELECT 
                    id, user_id, content, category, type, source, 
                    metadata, created_at
                FROM omi_memories 
                WHERE id = $1
            `, [memoryId]);

            if (result.rows.length === 0) {
                return null;
            }

            const row = result.rows[0];
            return {
                id: row.id,
                userId: row.user_id,
                content: row.content,
                category: row.category,
                type: row.type,
                source: row.source,
                metadata: row.metadata,
                timestamp: row.created_at.toISOString()
            };

        } catch (error) {
            console.error('❌ Error getting memory by ID:', error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Update a memory
     */
    async updateMemory(memoryId, newContent, newMetadata = {}) {
        if (!this.isInitialized) {
            throw new Error('PgVector storage not initialized');
        }

        const client = await this.pool.connect();
        try {
            // Generate new embedding for updated content
            const embedding = await this.generateEmbedding(newContent);

            const result = await client.query(`
                UPDATE omi_memories 
                SET 
                    content = $2,
                    metadata = $3,
                    embedding = $4,
                    updated_at = NOW()
                WHERE id = $1
            `, [
                memoryId,
                newContent,
                JSON.stringify(newMetadata),
                `[${embedding.join(',')}]`
            ]);

            return result.rowCount > 0;
        } catch (error) {
            console.error('❌ Error updating memory:', error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get memory categories for a user
     */
    async getMemoryCategories(userId) {
        if (!this.isInitialized) {
            throw new Error('PgVector storage not initialized');
        }

        const client = await this.pool.connect();
        try {
            const result = await client.query(`
                SELECT DISTINCT category 
                FROM omi_memories 
                WHERE user_id = $1 AND category IS NOT NULL
                ORDER BY category
            `, [userId]);

            return result.rows.map(row => row.category);
        } catch (error) {
            console.error('❌ Error getting memory categories:', error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Check if storage is ready
     */
    isReady() {
        return this.isInitialized && this.pool;
    }

    /**
     * Close the connection pool
     */
    async close() {
        if (this.pool) {
            await this.pool.end();
            console.log('✅ PgVector connection pool closed');
        }
    }
}

module.exports = PgVectorMemoryStorage;