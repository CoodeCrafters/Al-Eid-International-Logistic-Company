const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const mariadb = require('mariadb');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const morgan = require('morgan');
require('dotenv').config();
const puppeteer = require('puppeteer');
const handlebars = require('handlebars');

function getChromeExecutablePath() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        puppeteer.executablePath()
    ].filter(Boolean);

    const executablePath = candidates.find(candidate => fs.existsSync(candidate));
    if (!executablePath) {
        throw new Error('Chrome executable not found. Install Chrome or run: npx puppeteer browsers install chrome');
    }

    return executablePath;
}



const app = express();
const PORT = process.env.PORT || 5000;


// Fix for BigInt serialization in JSON responses
BigInt.prototype.toJSON = function () {
    return this.toString();
};

// Or use a middleware approach
app.use((req, res, next) => {
    const originalJson = res.json;
    res.json = function (data) {
        const jsonString = JSON.stringify(data, (key, value) => {
            if (typeof value === 'bigint') {
                return value.toString();
            }
            if (value === null || value === undefined) {
                return '';
            }
            return value;
        });
        res.setHeader('Content-Type', 'application/json');
        res.send(jsonString);
    };
    next();
});


// ==================== LOGGING SETUP ====================
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error'
        }),
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log')
        }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// HTTP request logging
const accessLogStream = fs.createWriteStream(
    path.join(logsDir, 'access.log'),
    { flags: 'a' }
);

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: accessLogStream }));

// Custom logging middleware
app.use((req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info({
            method: req.method,
            url: req.url,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            statusCode: res.statusCode,
            duration: `${duration}ms`,
            timestamp: new Date().toISOString()
        });
    });

    next();
});

const pool = mariadb.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3406,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'al_eid_pos',
    connectionLimit: 100, // Max 100 concurrent connections
    acquireTimeout: 10000,
    waitForConnections: true,
    queueLimit: 0,
    ssl: false,
    compress: false,
    permitLocalInfile: false,
    connectTimeout: 15000,
    allowPublicKeyRetrieval: true,
    charset: 'utf8mb4'
});

class BrowserPool {
    constructor() {
        this.browsers = [];
        this.maxBrowsers = 3;
        this.currentIndex = 0;
        this.waitingQueue = [];
        this.isClosing = false;
    }

    async getBrowser() {
        if (this.isClosing) {
            throw new Error('Browser pool is closing');
        }

        // If we have available browsers, use one
        const available = this.browsers.filter(b => b.isAvailable && !b.isClosing);
        if (available.length > 0) {
            const browser = available[0];
            browser.isAvailable = false;
            return browser;
        }

        // If we can create a new browser
        if (this.browsers.length < this.maxBrowsers) {
            try {
                const browser = await puppeteer.launch({
                    headless: true,
                    executablePath: getChromeExecutablePath(),
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--max-old-space-size=512'
                    ]
                });
                browser.isAvailable = false;
                browser.isClosing = false;
                this.browsers.push(browser);
                console.log(`[BrowserPool] Created new browser (Total: ${this.browsers.length})`);
                return browser;
            } catch (error) {
                console.error('[BrowserPool] Failed to launch browser:', error);
                throw error;
            }
        }

        // Wait for a browser to become available
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                const index = this.waitingQueue.indexOf(resolve);
                if (index > -1) {
                    this.waitingQueue.splice(index, 1);
                    reject(new Error('Timeout waiting for browser'));
                }
            }, 30000); // 30 second timeout
            
            this.waitingQueue.push((browser) => {
                clearTimeout(timeout);
                resolve(browser);
            });
        });
    }

    releaseBrowser(browser) {
        if (!browser) return;
        
        // Check if browser is still usable
        if (browser.isClosing || !browser.isConnected()) {
            // Remove dead browser
            const index = this.browsers.indexOf(browser);
            if (index > -1) {
                this.browsers.splice(index, 1);
                console.log(`[BrowserPool] Removed dead browser (Remaining: ${this.browsers.length})`);
            }
            // Try to fulfill waiting queue
            this._processWaitingQueue();
            return;
        }
        
        browser.isAvailable = true;
        console.log(`[BrowserPool] Released browser (Available: ${this.browsers.filter(b => b.isAvailable).length})`);
        
        this._processWaitingQueue();
    }

    _processWaitingQueue() {
        if (this.waitingQueue.length === 0) return;
        
        const available = this.browsers.filter(b => b.isAvailable && !b.isClosing);
        if (available.length === 0) return;
        
        const resolve = this.waitingQueue.shift();
        const browser = available[0];
        browser.isAvailable = false;
        resolve(browser);
    }

    async closeAll() {
        this.isClosing = true;
        console.log('[BrowserPool] Closing all browsers...');
        
        // Reject all waiting requests
        while (this.waitingQueue.length > 0) {
            const reject = this.waitingQueue.shift();
            reject(new Error('Browser pool is closing'));
        }
        
        for (const browser of this.browsers) {
            try {
                browser.isClosing = true;
                await browser.close();
            } catch (error) {
                console.error('[BrowserPool] Error closing browser:', error);
            }
        }
        this.browsers = [];
        console.log('[BrowserPool] All browsers closed');
    }
}

const browserPool = new BrowserPool();


// Queue for all PDF requests
const pdfQueue = [];
let isProcessingPDF = false;
let activePDFCount = 0;
const MAX_CONCURRENT_PDF = 3; // Max 3 PDFs generating at once

async function processPDFQueue() {
    // Don't process if already running or queue is empty
    if (isProcessingPDF || pdfQueue.length === 0) return;
    
    isProcessingPDF = true;
    
    while (pdfQueue.length > 0 && activePDFCount < MAX_CONCURRENT_PDF) {
        const request = pdfQueue.shift();
        activePDFCount++;
        
        // Process the PDF request
        processPDFRequest(request).finally(() => {
            activePDFCount--;
            // Continue processing queue
            if (pdfQueue.length > 0 && activePDFCount < MAX_CONCURRENT_PDF) {
                processPDFQueue();
            }
        });
    }
    
    isProcessingPDF = false;
}

async function processPDFRequest({ jobId, res, type, browser }) {
    let pdfBrowser = browser;
    let needsRelease = false;
    
    try {
        // Get browser from pool if not provided
        if (!pdfBrowser) {
            pdfBrowser = await browserPool.getBrowser();
            needsRelease = true;
        }
        
        console.log(`[PDF Queue] Processing ${type} PDF for ID: ${jobId} (Active: ${activePDFCount})`);
        
        // Generate PDF based on type
        if (type === 'jobcard') {
            await generateJobCardPDF(jobId, res, pdfBrowser);
        } else if (type === 'invoice') {
            await generateInvoicePDF(jobId, res, pdfBrowser);
        } else if (type === 'proforma') {
            await generateProformaPDF(jobId, res, pdfBrowser);
        } else {
            throw new Error(`Unknown PDF type: ${type}`);
        }
        
        console.log(`[PDF Queue] Completed ${type} PDF for ID: ${jobId}`);
        
    } catch (error) {
        console.error(`[PDF Queue] Error generating ${type} PDF:`, error);
        if (!res.headersSent) {
            res.status(500).json({ 
                success: false, 
                message: `Failed to generate ${type} PDF: ${error.message}` 
            });
        }
    } finally {
        if (needsRelease && pdfBrowser) {
            browserPool.releaseBrowser(pdfBrowser);
        }
    }
}

// Helper function to queue PDF request
function queuePDFRequest(jobId, res, type) {
    // Check if this exact request is already in queue (prevent duplicates)
    const existing = pdfQueue.find(req => req.jobId === jobId && req.type === type);
    if (existing) {
        console.log(`[PDF Queue] Request for ${type} ${jobId} already in queue, merging...`);
        // Replace the response with the new one (keep the latest)
        existing.res = res;
        return;
    }
    
    pdfQueue.push({ jobId, res, type });
    console.log(`[PDF Queue] Added ${type} ${jobId} to queue (Queue size: ${pdfQueue.length})`);
    
    // Start processing if not already running
    if (!isProcessingPDF) {
        processPDFQueue();
    }
}


// Get connection from pool
async function getDbConnection() {
    try {
        return await pool.getConnection();
    } catch (error) {
        console.error('Database connection failed:', error.message);
        throw error;
    }
}

// Release connection back to pool
async function releaseConnection(conn) {
    if (conn) {
        try {
            await conn.release();
        } catch (error) {
            console.error('Error releasing connection:', error.message);
        }
    }
}

// Database helper function - UPDATED to use pool
async function executeQuery(query, params = []) {
    let conn;
    try {
        conn = await pool.getConnection();
        const result = await conn.query(query, params);
        return { success: true, data: result };
    } catch (error) {
        logger.error('Query failed', { query, error: error.message });
        return { success: false, error: error.message };
    } finally {
        if (conn) await conn.release();
    }
}

// Test database connection - UPDATED
async function testDatabaseConnection() {
    let conn;
    try {
        console.log('Testing database connection...');
        conn = await pool.getConnection();
        const result = await conn.query('SELECT NOW() as timestamp, VERSION() as version, DATABASE() as db');
        console.log('Database connected successfully!');
        return true;
    } catch (error) {
        console.error('Database connection failed:', error.message);
        return false;
    } finally {
        if (conn) await conn.release();
    }
}

// ==================== JOB CARD NUMBER GENERATOR ====================
// Replace the existing generateJobCardNumber function with this corrected version:
async function generateJobCardNumber(modeOfTravel, shipmentType) {
    let conn;
    try {
        const year = new Date().getFullYear();
        conn = await getDbConnection();

        await conn.beginTransaction();

        // Create prefix based on mode
        let prefix = "";
        switch (modeOfTravel) {
            case 'ROA': prefix = 'ROA'; break;
            case 'AIR': prefix = 'AIR'; break;
            case 'SEA': prefix = 'SEA'; break;
            case 'MUL': prefix = 'MUL'; break;
            case 'SJ': prefix = 'SJ'; break;  // ← ADD SJ SUPPORT
            default: prefix = 'JC';
        }

        // Add shipment type suffix
        let typeSuffix = "";
        let typeLetter = "";
        switch (shipmentType) {
            case 'I':
            case 'IMPORT': 
                typeSuffix = '-I-'; 
                typeLetter = 'I';
                break;
            case 'E':
            case 'EXPORT': 
                typeSuffix = '-E-'; 
                typeLetter = 'E';
                break;
            case 'D':
            case 'DOMESTIC': 
                typeSuffix = '-D-'; 
                typeLetter = 'D';
                break;
            case 'SJ':
            case 'SERVICE':
                typeSuffix = '-';
                typeLetter = '';
                break;
            default: typeSuffix = '-';
        }

        // Custom starting numbers
        const startingNumbers = {
            // ROAD
            'ROA-I': 45785,
            'ROA-E': 50000,
            'ROA-D': 60000,
            // AIR
            'AIR-I': 1000,
            'AIR-E': 2000,
            'AIR-D': 3000,
            // SEA
            'SEA-I': 40000,
            'SEA-E': 844512,
            'SEA-D': 900000,
            // MULTIMODAL
            'MUL-I': 3000,
            'MUL-E': 4000,
            'MUL-D': 5000,
            // SERVICE JOB (SJ) - NO TYPE SUFFIX
            'SJ-': 1,  // ← ADD SJ STARTING NUMBER
        };

        // For SJ, use 'SJ-' as the key (no type letter)
        let combinationKey = `${prefix}-${typeLetter}`;
        // If typeLetter is empty (SJ case), use just the prefix
        if (!typeLetter) {
            combinationKey = `${prefix}-`;
        }
        
        let startNumber = startingNumbers[combinationKey] || 1;

        // Construct search pattern
        let searchPattern;
        if (prefix === 'SJ') {
            // SJ pattern: SJ-2026-000001 (no type suffix)
            searchPattern = `SJ-${year}-%`;
        } else {
            searchPattern = `${prefix}${typeSuffix}${year}-%`;
        }

        const maxJobResult = await conn.query(`
            SELECT MAX(CAST(SUBSTRING_INDEX(job_no, '-', -1) AS UNSIGNED)) as max_number
            FROM job_cards 
            WHERE job_no LIKE ?
        `, [searchPattern]);

        let nextNumber = startNumber;
        if (maxJobResult[0]?.max_number) {
            const maxNum = Number(maxJobResult[0].max_number);
            if (!isNaN(maxNum) && maxNum > 0) {
                nextNumber = Math.max(maxNum + 1, startNumber);
            }
        }

        const formattedNumber = nextNumber.toString().padStart(6, '0');
        
        // Generate job number
        let jobNumber;
        if (prefix === 'SJ') {
            // SJ-2026-000001
            jobNumber = `${prefix}-${year}-${formattedNumber}`;
        } else {
            jobNumber = `${prefix}${typeSuffix}${year}-${formattedNumber}`;
        }

        await conn.commit();

        console.log('Generated job number:', jobNumber);

        return jobNumber;

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Job card number generation error:', error);
        const year = new Date().getFullYear();
        const timestamp = Date.now();
        return `JC-${year}-${timestamp.toString().slice(-6)}`;
    } finally {
        if (conn) await conn.end();
    }
}


// Test database connection
async function testDatabaseConnection() {
    let conn;
    try {
        console.log('🔌 Testing database connection...');
        conn = await getDbConnection();
        const result = await conn.query('SELECT NOW() as timestamp, VERSION() as version, DATABASE() as db');

        console.log('✅ Database connected successfully!');
        await conn.end();
        return true;

    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        if (conn) await conn.end();
        return false;
    }
}

// Database helper function
async function executeQuery(query, params = []) {
    let conn;
    try {
        conn = await getDbConnection();
        const result = await conn.query(query, params);
        return { success: true, data: result };
    } catch (error) {
        logger.error('Query failed', { query, error: error.message });
        return { success: false, error: error.message };
    } finally {
        if (conn) await conn.end();
    }
}

// Initialize database
async function initializeDatabase() {
    try {
        console.log('📊 Initializing database tables...');
        await createEntityTables();
        await migrateLocationFields();

        // Users table
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                gender ENUM('male', 'female') NOT NULL,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role ENUM('admin', 'manager', 'employee', 'cashier') DEFAULT 'employee',
                status ENUM('pending', 'approved', 'active', 'rejected', 'suspended') DEFAULT 'pending',
                is_verified BOOLEAN DEFAULT FALSE,
                verification_code VARCHAR(10),
                verification_expiry DATETIME,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                verified_at DATETIME,
                last_login DATETIME,
                login_attempts INT DEFAULT 0,
                account_locked BOOLEAN DEFAULT FALSE
            )
        `);

        // OTP store table
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS otp_store (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                otp VARCHAR(10) NOT NULL,
                expires_at DATETIME NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_id (user_id),
                INDEX idx_expires_at (expires_at)
            )
        `);

        // Sessions table
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS sessions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                token TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME NOT NULL,
                ip_address VARCHAR(45),
                user_agent TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_id (user_id),
                INDEX idx_expires_at (expires_at)
            )
        `);

        // Audit logs table
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(36),
                action VARCHAR(50) NOT NULL,
                details TEXT,
                ip_address VARCHAR(45),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user_id (user_id),
                INDEX idx_action (action),
                INDEX idx_created_at (created_at)
            )
        `);

        // Email logs table
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS email_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                recipient VARCHAR(100) NOT NULL,
                subject VARCHAR(255) NOT NULL,
                status ENUM('sent', 'failed', 'pending') DEFAULT 'pending',
                error_message TEXT,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_recipient (recipient),
                INDEX idx_status (status),
                INDEX idx_sent_at (sent_at)
            )
        `);



        await executeQuery(`
            CREATE TABLE IF NOT EXISTS job_cards (
                id VARCHAR(36) NOT NULL PRIMARY KEY,
                job_no VARCHAR(50) NOT NULL UNIQUE,
                date DATE NOT NULL,
                estd DATETIME NOT NULL,
                eta DATETIME NOT NULL,
                cost_center VARCHAR(100) NOT NULL,
                customer_ref_no VARCHAR(100),
                requester_name VARCHAR(200) NOT NULL,
                customer_name VARCHAR(200) NOT NULL,
                customer_address TEXT NOT NULL,
                email VARCHAR(100),
                phone VARCHAR(50),
                truck_waybill_no VARCHAR(100) NOT NULL UNIQUE,
                shipper_name VARCHAR(200) NOT NULL,
                shipper_ref_no VARCHAR(100),
                bayan_no VARCHAR(100),
                bayan_date DATE,
                gross_weight DECIMAL(10,2) DEFAULT 0,
                packages INT DEFAULT 0,
                package_type VARCHAR(50),
                dimensions VARCHAR(100),
                description TEXT,
                special_instructions TEXT,
                status ENUM('draft', 'submitted', 'approved', 'rejected', 'completed') DEFAULT 'draft',
                created_by VARCHAR(100),
                user_id VARCHAR(36),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                submitted_at DATETIME,
                submitted_by VARCHAR(100),
                approved_at DATETIME,
                approved_by VARCHAR(100),
                completed_at DATETIME,
                invoice_no VARCHAR(100),
                departure_location VARCHAR(200) DEFAULT 'Not Specified',
                arrival_location VARCHAR(200),
                hbl VARCHAR(100),
                mbl VARCHAR(100),
                habw VARCHAR(100),
                mabw VARCHAR(100),
                road_waybill VARCHAR(100),
                multimodal_ref VARCHAR(100),
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_customer_name (customer_name),
                INDEX idx_shipper_name (shipper_name),
                INDEX idx_status (status),
                INDEX idx_user_id (user_id),
                INDEX idx_created_at (created_at),
                INDEX idx_departure_location (departure_location),
                INDEX idx_arrival_location (arrival_location)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        console.log('Job cards table created/verified');

        await executeQuery(`
            CREATE TABLE IF NOT EXISTS job_cards_history (
                history_id INT AUTO_INCREMENT PRIMARY KEY,
                job_card_id VARCHAR(36) NOT NULL,
                action VARCHAR(50) NOT NULL,
                version_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                transporter_id VARCHAR(36) DEFAULT NULL,
                transporter_name VARCHAR(200) DEFAULT NULL,
                job_no VARCHAR(50),
                operation_date DATE,
                cargo_type_id VARCHAR(36),
                service_mode_id VARCHAR(36),
                incoterm_id VARCHAR(36),
                cc_regime_id VARCHAR(36),
                transport_mode_id VARCHAR(36),
                shipment_type_id VARCHAR(36),
                responsible_person_id VARCHAR(36),
                mawb VARCHAR(100),
                hawb VARCHAR(100),
                cost_center VARCHAR(100),
                cost_center_number VARCHAR(50),
                shipping_line VARCHAR(100),
                no_of_packages INT,
                packages_unit VARCHAR(20),
                gross_weight DECIMAL(10,2),
                gross_weight_unit VARCHAR(20),
                nett_weight DECIMAL(10,2),
                nett_weight_unit VARCHAR(20),
                chargeable_weight DECIMAL(10,2),
                chargeable_weight_unit VARCHAR(20),
                volume VARCHAR(100),
                shipper_ref_no VARCHAR(100),
                customer_id VARCHAR(36),
                consignee_id VARCHAR(36),
                shipper_id VARCHAR(36),
                agent_id VARCHAR(36),
                pol VARCHAR(100),
                pod VARCHAR(100),
                atd DATE,
                ata DATE,
                transit_time VARCHAR(50),
                driver_name VARCHAR(200),
                vehicle_number VARCHAR(50),
                delivery_location TEXT,
                customs_location TEXT,
                contact_person VARCHAR(100),
                contact_details TEXT,
                contact_email VARCHAR(100),
                declaration_number VARCHAR(100),
                declaration_date DATE,
                bayan_no VARCHAR(100),
                bayan_date DATE,
                clearance_date DATE,
                delivery_date DATE,
                cc_number VARCHAR(100),
                requestor_name VARCHAR(100),
                po_number VARCHAR(100),
                delivery_status VARCHAR(50),
                commercial_invoice_no VARCHAR(100),
                master_remarks TEXT,
                delivery_remarks TEXT,
                attested_docs_received VARCHAR(10),
                deposit_category VARCHAR(100),
                deposit_amount DECIMAL(15,2),
                deposit_currency VARCHAR(10) DEFAULT 'KD',
                deposit_applied_date DATE,
                customs_deposit_release_no VARCHAR(100),
                deposit_refund_last_date DATE,
                clearance_remarks TEXT,
                ministry_approval_ids JSON,
                bank_guarantee_number VARCHAR(100),
                issuance_bank VARCHAR(100),
                bg_amount DECIMAL(15,2),
                ti_bayan_expiry_date DATE,
                ti_file_status VARCHAR(50) DEFAULT 'OPEN',
                ti_part_number VARCHAR(100),
                partial_re_export VARCHAR(10) DEFAULT 'NO',
                partial_re_export_pn VARCHAR(100),
                ti_remarks TEXT,
                te_part_number VARCHAR(100),
                te_bayan_expiry_date DATE,
                te_file_status VARCHAR(50) DEFAULT 'OPEN',
                te_remarks TEXT,
                status VARCHAR(50),
                created_by VARCHAR(100),
                user_id VARCHAR(36),
                created_at DATETIME,
                invoice_no VARCHAR(100),
                INDEX idx_job_card_id (job_card_id),
                INDEX idx_version_timestamp (version_timestamp)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Job cards history table created/verified');

        await executeQuery(`
            CREATE TABLE IF NOT EXISTS customers (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                company VARCHAR(200) DEFAULT '',
                email VARCHAR(100) DEFAULT '',
                phone VARCHAR(50) DEFAULT '',
                address TEXT DEFAULT '',
                reference_number VARCHAR(100) DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_email (email),
                INDEX idx_phone (phone)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        console.log('✅ Customers table created/verified');

        // 3. Shippers table
        // ==================== SHIPPERS TABLE ====================
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS shippers (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                reference_number VARCHAR(100),
                phone VARCHAR(50),
                email VARCHAR(100),
                company VARCHAR(200),
                address TEXT,
                country VARCHAR(100),
                contact_person VARCHAR(200),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_reference_number (reference_number),
                INDEX idx_company (company)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Shippers table created/verified');

        // ==================== CONSIGNEES TABLE ====================
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS consignees (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                reference_number VARCHAR(100),
                phone VARCHAR(50),
                email VARCHAR(100),
                address TEXT,
                country VARCHAR(100),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_reference_number (reference_number)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Consignees table created/verified');

        // ==================== AGENTS TABLE ====================
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS agents (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                phone VARCHAR(50) NOT NULL,
                email VARCHAR(100),
                company VARCHAR(200),
                address TEXT,
                country VARCHAR(100),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_phone (phone)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Agents table created/verified');

        // ==================== DRIVERS TABLE ====================
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS drivers (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                phone VARCHAR(50) NOT NULL,
                email VARCHAR(100),
                license_number VARCHAR(100),
                address TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_phone (phone),
                INDEX idx_license_number (license_number)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Drivers table created/verified');

        // ==================== CONTACT PERSONS TABLE ====================
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS contact_persons (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                reference_number VARCHAR(100),
                phone VARCHAR(50) NOT NULL,
                email VARCHAR(100),
                company VARCHAR(200),
                consignee_id VARCHAR(36),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (consignee_id) REFERENCES consignees(id) ON DELETE SET NULL,
                INDEX idx_name (name),
                INDEX idx_phone (phone),
                INDEX idx_consignee_id (consignee_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Contact Persons table created/verified');

        // 4. Invoices table - UPDATED VERSION
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS invoices (
                id VARCHAR(36) PRIMARY KEY,
                invoice_no VARCHAR(100) UNIQUE NOT NULL,
                job_card_id VARCHAR(36),
                customer_id VARCHAR(36),
                date DATE NOT NULL,
                due_date DATE NOT NULL,
                subtotal DECIMAL(10,3) DEFAULT 0,
                tax DECIMAL(10,3) DEFAULT 0,
                total DECIMAL(10,3) DEFAULT 0,
                status ENUM('draft', 'sent', 'paid', 'overdue', 'cancelled') DEFAULT 'draft',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                sent_at DATETIME,
                paid_at DATETIME,
                created_by VARCHAR(100),
                notes TEXT,
                FOREIGN KEY (job_card_id) REFERENCES job_cards(id) ON DELETE SET NULL,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
                INDEX idx_invoice_no (invoice_no),
                INDEX idx_status (status),
                INDEX idx_date (date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        console.log('✅ Invoices table created/verified');

        // 5. Invoice items table
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS invoice_items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                invoice_id VARCHAR(36) NOT NULL,
                description VARCHAR(500) NOT NULL,
                charge_type ENUM('required', 'marginal') DEFAULT 'required',
                quantity DECIMAL(10,2) NOT NULL,
                unit VARCHAR(50),
                rate DECIMAL(10,2) NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_invoice_id (invoice_id),
                INDEX idx_charge_type (charge_type)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);


        // Add to initializeDatabase() function
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS invoice_numbers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                year INT NOT NULL,
                last_number INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_year (year),
                INDEX idx_year (year)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await executeQuery(`
            CREATE TABLE IF NOT EXISTS job_card_numbers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                year INT NOT NULL,
                last_number INT DEFAULT 0,
                current_year BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_year (year),
                INDEX idx_year (year)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);



        // Add to initializeDatabase() function after other table creations:

        // Advance Payments table
        await executeQuery(`
    CREATE TABLE IF NOT EXISTS advance_payments (
        id VARCHAR(36) PRIMARY KEY,
        invoice_id VARCHAR(36) NOT NULL,
        amount DECIMAL(10,3) NOT NULL,
        payment_date DATE NOT NULL,
        payment_method VARCHAR(50),
        reference_number VARCHAR(100),
        notes TEXT,
        created_by VARCHAR(100),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
        INDEX idx_invoice_id (invoice_id),
        INDEX idx_payment_date (payment_date),
        INDEX idx_payment_method (payment_method)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);

        console.log('✅ Advance payments table created/verified');

        // Proforma Invoices table (Drafts)
        await executeQuery(`
    CREATE TABLE IF NOT EXISTS proforma_invoices (
        id VARCHAR(36) PRIMARY KEY,
        proforma_no VARCHAR(50) UNIQUE NOT NULL,
        job_card_id VARCHAR(36) NOT NULL,
        job_no VARCHAR(100),
        customer_id VARCHAR(36),
        customer_name VARCHAR(255),
        total DECIMAL(10,3) DEFAULT 0,
        subtotal DECIMAL(10,3) DEFAULT 0,
        items_json JSON,
        advance_payment_json JSON,
        notes TEXT,
        created_by VARCHAR(100),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_job_card_id (job_card_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);

        console.log('✅ Proforma invoices table created/verified');

        // Invoice Charges table (more detailed than invoice_items)
        await executeQuery(`
    CREATE TABLE IF NOT EXISTS invoice_charges (
        id VARCHAR(36) PRIMARY KEY,
        invoice_id VARCHAR(36) NOT NULL,
        charge_type VARCHAR(100),
        description VARCHAR(500) NOT NULL,
        quantity DECIMAL(10,3) NOT NULL,
        unit VARCHAR(50),
        unit_amount DECIMAL(10,3) NOT NULL,
        total_amount DECIMAL(10,3) NOT NULL,
        tax_rate DECIMAL(5,2) DEFAULT 0,
        tax_amount DECIMAL(10,3) DEFAULT 0,
        charge_category VARCHAR(100),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
        INDEX idx_invoice_id (invoice_id),
        INDEX idx_charge_type (charge_type),
        INDEX idx_charge_category (charge_category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);

        console.log('✅ Invoice charges table created/verified');

        // Dashboard Stats Cache table (optional, for performance)
        await executeQuery(`
    CREATE TABLE IF NOT EXISTS dashboard_stats_cache (
        id INT AUTO_INCREMENT PRIMARY KEY,
        stat_date DATE NOT NULL,
        total_job_cards INT DEFAULT 0,
        transit_job_cards INT DEFAULT 0,
        arrived_job_cards INT DEFAULT 0,
        completed_job_cards INT DEFAULT 0,
        total_invoices INT DEFAULT 0,
        total_revenue DECIMAL(15,3) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_stat_date (stat_date),
        INDEX idx_stat_date (stat_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);

        console.log('✅ Dashboard stats cache table created/verified');



        console.log('✅ Invoice numbers table created/verified');

        // In initializeDatabase() function
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS description_charges (
                id VARCHAR(36) PRIMARY KEY,
                charge_name VARCHAR(255) UNIQUE NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_charge_name (charge_name),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        console.log('✅ Description charges table created/verified');

        console.log('✅ Invoice items table created/verified');

        await initializeInvoiceNumbers();


        // Shipping Lines / Airlines table
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS shipping_lines (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                code VARCHAR(50),
                type ENUM('shipping', 'airline') DEFAULT 'shipping',
                country VARCHAR(100),
                is_active BOOLEAN DEFAULT TRUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_code (code),
                INDEX idx_type (type),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Ports table
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS ports (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                code VARCHAR(50),
                country VARCHAR(100),
                city VARCHAR(100),
                type ENUM('seaport', 'airport', 'inland') DEFAULT 'seaport',
                is_active BOOLEAN DEFAULT TRUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_code (code),
                INDEX idx_country (country),
                INDEX idx_type (type),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

       

        await migrateExistingCustomers();
        await populateDefaultCharges();
        // Check if admin user exists
        const adminCheck = await executeQuery(
            "SELECT id FROM users WHERE username = 'admin'"
        );

        if (adminCheck.success && adminCheck.data.length === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            const adminId = uuidv4();

            await executeQuery(`
                INSERT INTO users (
id, name, email, gender, username, password, role, status, is_verified, verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                adminId,
                'System Administrator',
                process.env.ADMIN_EMAIL || 'admin@al-eid-logistics.com',
                'male',
                'admin',
                hashedPassword,
                'admin',
                'active',
                1,
                new Date()
            ]);

            console.log('👑 Default admin user created');
            console.log('   Username: admin');
            console.log('   Password: admin123');
            console.log('⚠️  CHANGE THIS PASSWORD IMMEDIATELY!');
        }

        console.log('✅ Database tables initialized successfully');
        return true;

    } catch (error) {
        console.error('❌ Database initialization failed:', error.message);
        return false;
    }
}


async function populateDefaultCharges() {
    let conn;
    try {
        console.log('📝 Checking for new charge types...');

        const chargesList = [
            "1SC- IMPORT SERVICE CHARGES",
            "ADDING COUNTRY OF ORIGIN",
            "ADDITIONAL BAYAN PAGES",
            "ADDITIONAL BAYAN PER 5 LINE ITEMS",
            "ADDITIONAL CHARGE",
            "ADDITIONAL CUSTOMS DOCUMENTATION PER 5 LINE ITEMS",
            "ADDITIONAL LINE ITEMS (3 KD PER 5 LINE)",
            "ADVANCE CUSTOM DUTY",
            "ADVANCE DELIVERY ORDER CHARGES",
            "AGENT COST RECOVERY CHARGES",
            "AIR FREIGHT CHARGES",
            "AIRPORT HANDLING CHARGES",
            "AIRPORT STORAGE CHARGES",
            "AIRWAY BILL FEE",
            "AL-EID HANDLING CHARGES",
            "AL-EID SERVICE CHARGES",
            "AL RASHED INTERNATIONAL SHIPPING CO",
            "AL-SOUHUB INTERNATIONAL",
            "APPROVAL FROM GENERAL DEPARTMENT OF CRIMINAL EVIDENCE (8) MOI",
            "APPROVAL FROM THE SPECIAL FORCES (81) MOI",
            "BANK COMMISION IN UAE",
            "BANK COMMISSION",
            "BANK COMMISSION IN K.S.A",
            "BANK TRANSFER CHARGES",
            "BATHA SPECIAL CLEARANCE CHARGES",
            "Bayan",
            "BAYAN CANCELLATION",
            "BAYAN DATA ENTRY FEE",
            "BAYAN FOR DIRECT DELIVERY",
            "BELT CHARGES",
            "BONDED BOE",
            "BORDER CHARGES",
            "BORDER CHARGES + CUSTOM DUTY K.S.A",
            "BUNKER FEE",
            "CANCELLATION CHARGES",
            "CARGO FEES",
            "CHAMBER OF COMMERCE LEGALIZATION CHARGES",
            "CHAMBER OF COMMERCE LEGALIZATION SERVICE CHARGES",
            "CHANGE IN LOCATION",
            "CHEMICAL LICENSE USAGE-LAND",
            "CITRA RECEIPT",
            "CIVIL AVIATION - (13)",
            "CLEARANCE AGENCY HANDLING",
            "CLEARANCE AT NUWAISEEB BORDER",
            "CLEARANCE CHARGES",
            "CLEARANCE & LABOR CHARGES",
            "CLOSING TEMPORARY IMPORT FILE",
            "CMA CGM",
            "CMA REFUND",
            "CONTAINER MAINTENANCE CHARGES",
            "CONTAINER RELEASE CHARGES",
            "CONTAINER RELEASE EXTENSION CHARGES",
            "CONTAINER REPAIR MAINTENANCE CHARGE",
            "CONTAINER STUFFING",
            "CONTAINER SUPERVISION CHARGES",
            "CONTAINER UNSTUFFING",
            "CONVERT TEMPORARY IMPORT BAYAN TO PERMANENT IMPORT",
            "COO & INVOICE ATTESTATION CHARGES",
            "COO SERVICE CHARGES",
            "COURIER CHARGES",
            "CRANE",
            "CRANE CHARGES",
            "CRANE SUPERVISION CHARGES",
            "CRANE SUPERVISION CHARGES 2 DAYS",
            "CRANE SUPERVISION CHARGES 9 DAYS",
            "CROSS DOCKING CHARGES - AHMADI",
            "CROSS DOCKING CHARGES - NORTH KUWAIT",
            "CUSTOM DUTY IN KSA",
            "CUSTOM DUTY IN KUWAIT",
            "CUSTOM DUTY IN UAE",
            "CUSTOMS AMENDMENT CHARGES",
            "CUSTOMS APPROVAL CHARGES",
            "CUSTOMS CHARGES",
            "CUSTOMS CHARGES AMENDED",
            "CUSTOMS CLEARANCE SERVICE CHARGE",
            "CUSTOMS CLEARANCE SERVICE CHARGE (NUWASIB)",
            "CUSTOMS CLEARANCE SERVICE CHARGE (SALMI)",
            "CUSTOMS DEPOSIT",
            "CUSTOMS DEPOSIT - NON-REFUNDABLE",
            "CUSTOMS DEPOSIT - REFUNDABLE",
            "CUSTOMS DEPOSIT - ( TI )",
            "CUSTOMS DOCUMENTATION FEES",
            "CUSTOMS DUTIES AND VAT IN UAE",
            "CUSTOMS DUTY",
            "CUSTOMS DUTY AND OTHER CUSTOMS CHARGES",
            "CUSTOMS DUTY HANDLING",
            "CUSTOMS FEES",
            "CUSTOMS FEES (PAI)",
            "CUSTOMS MANIFEST CHARGE",
            "CUSTOMS PENALTY",
            "CUSTOMS RELEASE",
            "CUSTUM DUTY- ON REPAIR CHARGES",
            "DATA ENTRY PER 5 LINE ITEMS",
            "DELAY",
            "Delivery",
            "DELIVERY AGENCY HANDLING",
            "DELIVERY ORDER CHARGES",
            "DELIVERY ORDER CHARGES - 2 D/O",
            "DELIVERY ORDER CHARGES ( IN LAND TRANSPORTATION KHORFAKKHAN )",
            "DELIVERY ORDER CHARGES ( SEA FREIGHT FROM JEBEL ALI )",
            "DELIVERY ORDER COLLECTION SERVICE CHARGES",
            "DEMURRAGE CHARGES",
            "DEPOSIT CLEARANCE SERVICE FEES",
            "DEPOSIT REFUND SERVICE",
            "DESTINATION LINE TELEX FEE",
            "DETENTION",
            "DG HANDLING CHARGES",
            "DOCUMENTATION CHARGES",
            "DUBAI IMPORT CODE RENEWAL CHARGES",
            "DXB / AUH & ESCORT",
            "ELECTRONIC BAYAN",
            "EMERGENCY CONFLICT SURCHARGES",
            "ENVIRONMENTAL PUBLIC AUTHORITY APPROVAL (30)",
            "ENVIRONMENTAL PUBLIC AUTHORITY APPROVAL (31)",
            "ENVIRONMENTAL PUBLIC AUTHORITY APPROVAL (32)",
            "ENVIRONMENTAL PUBLIC AUTHORITY (EPA - KUWAIT)",
            "EQUIPMENT SURPLUS SURCHARGE (ESS)",
            "ESCORTING",
            "ESCORT & LOADER CHARGES",
            "EXPORT CUSTOM DUTY",
            "EXPORT DOCUMENTATION",
            "EXPORT NORMAL BAYAN",
            "EXTENTION OF TEMPORARY IMPORT PERMIT",
            "EXTRA BAYAN PAGES",
            "EXTRA BAYAN PAGES ( 3 KD PER 5 LINE)",
            "FEES FOR USING EPA CHEMICALS IMPORT LICENSE",
            "FEES FOR USING EXPORT LICENSE",
            "FEES FOR USING IMPORT LICENSE",
            "FILING CUSTOMS DOCUMENTS",
            "FILING ORIGINAL CUSTOMS CLEARANCES 5 YEARS X 2",
            "FILING ORIGINAL CUSTOMS DOCUMENTS FOR 5 YEARS",
            "FIRE APPROVAL CHARGES",
            "FITTING PACKING & BELT",
            "FLATRACK (SPECIAL LOWBED TRAILER)",
            "FORKLIFT",
            "FORKLIFT AND LABOR CHARGES",
            "FORKLIFT AND LABOR CHARGES 2 X 20",
            "FREIGHT 12X40' HC CONTAINERS",
            "FREIGHT 5X40' FR CONTAINERS",
            "FREIGHT CHARGES",
            "GATE PASS CHARGES",
            "GLOBAL CLEARINGHOUSE SYSTEMS CHARGES",
            "GLOBAL FREIGHT SYSTEMS CO.",
            "GULF MARITIME GEN TRD & CONT. CO.",
            "HANDLING CHARGES",
            "HANDLING IN",
            "HANDLING OUT",
            "HAPAG-LLOYD",
            "HIRE OF 2 RIGGERS (TRANSFORMER)",
            "HIRE OF 4 RIGGERS FOR 2 DAYS",
            "HIRE OF 4 RIGGERS FOR 9 DAYS",
            "HIRE OF CRANE (150 TONS)",
            "HIRE OF CRANE (150 TONS) FOR 12X40'HC ON 4TH & 8TH AUG.",
            "HIRE OF CRANE (200 TONS) 2 DAYS",
            "HIRE OF CRANE (200 TONS) 9 DAYS",
            "HIRE OF CRANE (200 TONS) FOR INSTALLATION OF PCRS FROM 5TH TILL 11TH AUG.",
            "HIRE OF RIGGERS FOR OFFLOADING 12 CONTAINERS & 5 PCR UNITS.",
            "HIRE OF RIGGERS FOR OFFLOADING 12 CONTAINERS & 5 PCR UNITS AS PER ATTACHED SIGNED TIME CARDS",
            "HIRE OF SUPERVISOR FOR INSTALLATION OF PCRS FROM 5TH TILL 11TH AUG.",
            "HIRE OF SUPERVISOR TO UNLOAD 12X40'HC ON 4TH & RELOAD ON 8TH",
            "IMPORT CODE RENEWAL CHARGES",
            "IMPORT CODE RENEWAL CHARGES- 2025",
            "IMPORT CODE RENEWAL CHARGES-(2025)",
            "IMPORT NORMAL BAYAN",
            "INDUSTRIAL DUTY EXEMPTION (B9)",
            "INITIAL REGISTRATION AT TRAFFIC DEPARTMENT",
            "INSPECTION CHARGES",
            "INSURANCE CHARGES",
            "INSURANCE CHARGES - ORIGIN",
            "INTERTEK",
            "INTERTEK FOR COC",
            "ISPS",
            "JABEL ALI CLEARANCE CHARGES",
            "JEBEL ALI BOE",
            "KFF - KUWAIT FIRE FORCE",
            "KSA CLEARANCE CHARGES",
            "KSA TRANSPORT DOCUMENT",
            "KUWAIT CERTIFIED LABORATORIES",
            "KUWAIT FIRE FORCE APPROVAL (14)",
            "KUWAIT PETROLEUM CORPORATION APPROVAL (15)",
            "KUWAIT PORTS AUTHORITY",
            "KUWAIT TRANSCONTINENTAL SHIPPING (KTS)",
            "KUWAIT TRANSLOADING AND LABOUR CHARGES",
            "LABCO",
            "LABOR CHARGES",
            "Labour",
            "LABOUR CHARGES",
            "LAND FREIGHT CHARGES",
            "LANKA SHIPPING & LOGISTICS (PVT) LTD.",
            "LEGALIZATION CHARGES",
            "LEGALIZATION FEE",
            "LEGALIZATION SERVICE CHARGES",
            "LICENSE CHARGES",
            "LIFTING PLAN",
            "LINE AMENDMENT CHARGES",
            "MAERSK",
            "Main Carriage",
            "MAKASA BOE CHARGES",
            "MAKASA BOE CHARGES + UAE CUSTOM DUTY CHARGES",
            "MANIFEST AUTOMATION CHARGES",
            "MANIFEST COLLECTION CHARGES",
            "MANIFEST SUBMISSION CHARGES",
            "MECANICAL CERTIFICATE",
            "MECANICAL SERVICE CHARGES",
            "MEDITERRANEAN SHIPPING (KUWAIT) CO.",
            "MICRO CLEARANCE CHARGES",
            "MIDDLE EAST LABORATORIES",
            "MINISTRY APPROVAL CHARGES",
            "MINISTRY OF AGRICULTURE APPROVAL (24)",
            "MINISTRY OF COMMERCE APPROVAL (27)",
            "MINISTRY OF COMMUNICATION APPROVAL (11)",
            "MINISTRY OF COMMUNICATION APPROVAL (28)",
            "MINISTRY OF DEFENCE (88)",
            "MINISTRY OF DEFENCE APPROVAL ( 26 )",
            "MINISTRY OF HEALTH APPROVAL",
            "MINISTRY OF HEALTH APPROVAL (29)",
            "MINISTRY OF HEALTH APPROVAL (29) (4)",
            "MINISTRY OF HEALTH APPROVAL (37)",
            "MINISTRY OF HEALTH APPROVAL ( 38 )",
            "MINISTRY OF HEALTH APPROVAL (4)",
            "MINISTRY OF HELATH",
            "MINISTRY OF INFORMATION ( 7 )",
            "MINISTRY OF INFORMATION ( 71 )",
            "MINISTRY OF INFORMATION ( 72 )",
            "MINISTRY OF INFORMATION ( 73 )",
            "MINISTRY OF INTERIOR APPROVAL (25)",
            "MINISTRY OF INTERIOR APPROVAL (8)",
            "MINISTRY OF INTERIOR APPROVAL (81)",
            "MINISTRY OF INTERIOR APPROVAL (82)",
            "MINISTRY OF INTERIOR APPROVAL (83)",
            "MINISTY OF COMMERCE APPRVAL (3)",
            "MOB/DEMOB OF CRANE (150 TONS) ON 4TH & 8TH AUG.",
            "MOB/DEMOB OF CRANE (150 TONS) X 2",
            "MOB/DEMOB OF CRANE (200 TONS) ON 5TH & 11TH AUG",
            "MOB/DEMOB OF CRANE (200 TONS) X 2",
            "MOBILIZATION CHARGES",
            "MOC APPROVAL SERVICE CHARGES",
            "MODEL AMENDMEND CHARGES",
            "MOFA LEGALIZATION CHARGES",
            "MOFA LEGALIZATION SERVICE CHARGES",
            "MOH (4, 29) (MR. MISHAL)",
            "MOHAMED ABDUL RAHMAN AL BAHAR SHIPPING",
            "MR. MISHAL",
            "MUNICIPALITY APPROVAL (2)",
            "OBTAIN 4 APPROVALS FROM CUSTOMS TO ADD MORE TRAILERS",
            "OFFLOADED THE FULL CONTAINERS ON GROUND THEN RELOADED THE EMPTY CONTAINERS ON TRUCKS",
            "OFFLOADING - WAFRA JO",
            "On Carriage",
            "OPEN CLOSED DELIVERY ORDER FROM CUSTOMS",
            "ORIGIN CFS LOADING FEE",
            "ORIGIN TELEX FEE",
            "OTHER CUSTOM CHARGES",
            "OTHER CUSTOMS CHARGES",
            "OTHER IMPORT TAXES",
            "OTHERS",
            "PALLET",
            "PENALTY",
            "PENALTY CHARGES",
            "PENALTY FOR UNPALLETIZED CARGO",
            "PERMIT AND ESCORT",
            "Pickup",
            "POLICE ESCORT",
            "PORT ADDITIONAL HANDLING CHARGES",
            "PORT AUTOMATION CHARGES",
            "PORT & CUSTOMS HANDLING FEE",
            "PORT HANDLING CHARGES",
            "PORT LABOR CHARGES",
            "PORT LABOUR CHARGES",
            "PORT LANDING CHARGES",
            "PORT SYSTEM HANDLING",
            "PORT/TERMINAL DUES AT DESTINATION",
            "PORT WEIGHTBRIDGE FEES",
            "Pre Carriage",
            "PRINTING AND STATIONERY",
            "PROFIT SHARE",
            "PUBLIC AUTHORITY FOR INDUSTRY APPROVAL (51)",
            "PUBLIC AUTHORITY FOR INDUSTRY APPROVAL (52)",
            "PUBLIC AUTHORITY FOR INDUSTRY RECEIPT",
            "PUBLIC AUTHORITY OF AGRICULTURE AFFAIRS",
            "RADIOACTIVE MOH",
            "RE-EXPORT APPROVAL",
            "RE-EXPORT FORMALITIES- JAFZA BONDED BOE AND UAE SILA BOEDER",
            "RE-IMPORT APPROVAL",
            "RE-IMPORT APPROVAL INCLUDING BAYAN CHARGES",
            "RE-IMPORT FORMALITIES- JAFZA BONDED BOE AND UAE SILA BORDER",
            "RENEWAL OF TEMPORARY IMPORT PERMIT",
            "REPACKING CHARGES",
            "RE-PACKING + WEIGHING CHARGES",
            "REPAIR & RETURN APPROVAL CHARGES INCLUDING BAYAN",
            "RETURN EMPTY CONTAINER",
            "ROAD PREPARATION",
            "SAUDI BORDER CHARGES",
            "SAUDI CLEARANCE SERVICE CHARGES",
            "SEA FREIGHT CHARGES",
            "SECONDARY SCREENING AT ORIGIN AIRPORT",
            "SERVICE CHARGE FOR CUSTOMS CLEARANCE",
            "SERVICE CHARGE FOR REFUND DEPOSIT",
            "SERVICE CHARGE ON DEPOSIT CLEARANCE",
            "SERVICE CHARGES 3%",
            "SHIFTING 5 PCRS FROM FR CONTAINERS TO LOWBED & RETURN EMPTY",
            "SHIFTING 5 PCRS FROM FR CONTAINERS TO LOWBED & RETURN EMPTY CONTAINER TO PORT",
            "SHORT CERTIFICATE",
            "SHORT CERTIFICATE SERVICE CHARGES",
            "SHORT LANDED CHARGES",
            "SHUAIBA GATE PASS",
            "SLA LOGISTICS",
            "SPECIAL APPROVAL CHARGE",
            "SPECIAL CLEARANCE CHARGES",
            "SPECIAL PUBLIC AUTHORITY FOR INDUSTRY APPROVAL (52)",
            "SPO CHARGES",
            "STAMPED DOCUMENTS OF 1ST PART & 2ND PART SHIPMENT",
            "STAMPED DOCUMENTS OF 1ST PART SHIPMENT",
            "STAMPS",
            "STAMPS OF MINISTRY",
            "STAMPS- PARTIAL SHIPMENT",
            "STAMPS - SHORT SHIPMENT",
            "STAND BY CHARGES",
            "STAND BY CHARGES - (LOWBED) X 12 DAYS X 350 PER DAY- AS PER THE ATTACHED",
            "STORAGE",
            "STORAGE CHARGES",
            "SWC HANDLING CHARGES",
            "TELEX FEE",
            "TEMPORARY ENTRY APPROVAL FEE INCLUDING BAYAN CHARGES",
            "TEMPORARY EXPORT APPROVAL",
            "TEMPORARY IMPORT APPROVAL",
            "TEMPORARY IMPORT CLOSURE AND OBTAIN REFUND",
            "TEMPORARY IMPORT PERMIT",
            "TEMPORARY IMPORT PERMIT CHARGES",
            "TEMPORARY IMPORT RENEWAL",
            "TERMINAL ADMINISTRATIVE FEE AT DESTINATION",
            "TERMINAL DRAYAGE FEE AT DESTINATION",
            "TERMINAL HANDLING CHARGES",
            "TI APPROVAL CHARGES",
            "TI CLOSED FILE",
            "TIP RENEWAL CHARGES",
            "TI RENEWAL APPROVAL",
            "TRAILER DAY 3 DAYS",
            "TRAILER DELAY",
            "TRAILER DELAY 1 DAY",
            "TRAILER DELAY 2 DAYS X 2 X 40",
            "TRAILER DELAY 2DAYS X 2 X 40",
            "TRAILER DELAY 2 DAYS X 3 X 40",
            "TRAILER DELAY 2DAYS X 4 X 40",
            "TRAILER DELAY 3 DAYS X 2 TRUCKS",
            "TRAILER DELAY 3 DAYS X 2 X 80",
            "TRAILER DELAY 3 DAYS X 6 X 40",
            "TRAILER DELAY 3 DAYS X 80",
            "TRAILER DELAY 4 DAYS X 3 X 40",
            "TRAILER DELAY AT INSPECTION",
            "TRAILER DELAY AT SEAPORT FOR CUSTOMS INSPECTION",
            "TRAILER DELAY DAYS",
            "TRAILER DELAY DAYS 2 X 5 X 40",
            "TRAILER DELAY DAYS 6 X 5 X 40",
            "TRAILER DELAY DAYS IN KUWAIT",
            "TRAILER DELAY DAYS IN UAE-",
            "TRAILER DELAY DAYS IN UAE/KUWAIT",
            "TRAILER DELAY LOWBED",
            "TRAILER DELAY LOWBED 2DAYS X 2 X 100)",
            "TRAILER DELAY LOWBED 2DAYS X 2 X 75",
            "TRANSIT VISA CHARGES",
            "TRANSLATION",
            "TRANSLOADING",
            "TRANSLOADING IN KUWAIT",
            "TRANSLOADING - UAE",
            "TRANSPORTATION AHMADI TO MINA",
            "TRANSPORTATION AT SITE SABRIYA WITH KOC GATE PASS",
            "TRANSPORTATION CHARGES",
            "TRANSPORTATION CHARGES 1 X 50 + 1 X 60",
            "TRANSPORTATION CHARGES - 200 TON CRANE",
            "TRANSPORTATION CHARGES - ABDALI",
            "TRANSPORTATION CHARGES - AFTER CUSTOMS RELEASE",
            "TRANSPORTATION CHARGES - AHMADI",
            "TRANSPORTATION CHARGES - AHMADI 20' FT",
            "TRANSPORTATION CHARGES - AHMADI 40' FT",
            "TRANSPORTATION CHARGES - AHMADI (LOWBED)",
            "TRANSPORTATION CHARGES - AHMADI - WAFRA",
            "TRANSPORTATION CHARGES - ( AHMADI - WAREHOUSE )",
            "TRANSPORTATION CHARGES - ( AHMADI - WAREHOUSE - AIRPORT )",
            "TRANSPORTATION CHARGES - AL THURAIYA",
            "TRANSPORTATION CHARGES - AMGHARA",
            "TRANSPORTATION CHARGES - AMGHARA - MINA ABDULLAH",
            "TRANSPORTATION CHARGES - ARDIYA",
            "TRANSPORTATION CHARGES - AT THE TIME OF INSPECTION",
            "TRANSPORTATION CHARGES - DAJEEJ",
            "TRANSPORTATION CHARGES - FLATBED",
            "TRANSPORTATION CHARGES - FLATBED TRAILER FROM SHUAIBA TO WAFRA JO",
            "TRANSPORTATION CHARGES - FLATBED TRAILER FROM SHUWAIKH TO WAFRA JO",
            "TRANSPORTATION CHARGES - FLATBED WAFRA",
            "TRANSPORTATION CHARGES- FROM SWC AMGHARA TO ABDALI",
            "TRANSPORTATION CHARGES - JABRIYA",
            "TRANSPORTATION CHARGES - JAHRA",
            "TRANSPORTATION CHARGES - KABAD",
            "TRANSPORTATION CHARGES - KDF",
            "TRANSPORTATION CHARGES - LOWBED TRAILER FROM SHUAIBA TO WAFRA JO",
            "TRANSPORTATION CHARGES - LOWBED TRAILER FROM SHUWAIKH TO WAFRA JO",
            "TRANSPORTATION CHARGES - LOWBED TRAILER MINA ABDULLAH TO WAFRA JO",
            "TRANSPORTATION CHARGES - MAHBOULA",
            "TRANSPORTATION CHARGES - MINA ABDULLAH",
            "TRANSPORTATION CHARGES - MINA ABDULLAH TO WAFRA JO",
            "TRANSPORTATION CHARGES - NORTH KUWAIT",
            "TRANSPORTATION CHARGES OF LTL FROM SWC AMGHARA TO KABAD",
            "TRANSPORTATION CHARGES OF LTL FROM SWC AMGHARA TO SHUAIBA",
            "TRANSPORTATION CHARGES - SABAH AL SALEM",
            "TRANSPORTATION CHARGES - SALMIYA",
            "TRANSPORTATION CHARGES - SHUAIBA",
            "TRANSPORTATION CHARGES - SHUAIBA TO WAFRA JO",
            "TRANSPORTATION CHARGES - SUBIYA",
            "TRANSPORTATION CHARGES - SULAIBIYA",
            "TRANSPORTATION CHARGES - SULAIBIYA / KABAD",
            "TRANSPORTATION CHARGES (TRAILER)",
            "TRANSPORTATION CHARGES -TRAILER FROM SHUWAIKH PORT TO WAFRA JO",
            "TRANSPORTATION CHARGES - WAFRA",
            "TRANSPORTATION CHARGES - ( WAREHOUSE - AIRPORT )",
            "TRANSPORTATION CHARGES - YAAL MALL",
            "TRANSPORTATION FOR SAMPLE",
            "TRANSPORTATION FROM JAFZA IN UAE TO KUWAIT USING 1 X 40 BOX TAILER @ KWD 600 EACH",
            "TRANSPORTATION FROM JAFZA IN UAE TO KUWAIT USING 2 X 40 BOX TRAILERS @ KWD 600 EACH",
            "TRANSPORTATION FROM KUWAIT TO JAFZA IN UAE USING 1X 40 BOX TRAILER @ KWD 375 EACH",
            "TRANSPORTATION FROM KUWAIT TO JAFZA IN UAE USING 2 X 40 BOX TRAILERS @ KWD 375 EACH",
            "TRANSPORTATION FROM SWC AMGHARA LTL SHIPMENT",
            "TRANSPORTATION-HALF WAY",
            "TRANSPORTATION-LOCAL",
            "TRANSPORTATION LOWBED",
            "TRANSPORTATION-LOWBED",
            "TRANSPORTATION LOW BED MINA ABDULLAH TO BURGAN",
            "TRANSPORTATION LOW BED SHUWAIKH TO MINA ABDULLAH",
            "TRANSPORTATION - LOWBED TRAILER",
            "TRANSPORTATION MINA ABDULLAH TO AHMADI",
            "TRANSPORTATION MINA TO AHMADI",
            "TRANSPORTATION-NORTH KUWAIT",
            "TRANSPORTATION OF 40' HC CONTAINER TO WJO ON 4TH AUG.",
            "TRANSPORTATION OF EACH 40' HC CONTAINER TO WJO ON 4TH AUG.",
            "TRANSPORTATION OF EACH PCR UNIT TO WJO ON 5TH AUG.",
            "TRANSPORTATION OF ONE UNSTUFFED 40'HC CONTAINER",
            "TRANSPORTATION OF PCR UNIT TO WJO ON 5TH AUG.",
            "TRANSPORTATION/RETURN THE EMPTY 40' HC TO SHUAIBA PORT",
            "TRANSPORTATION SHUWAIKH TO AHMADI",
            "TRANSPORTATION SHUWAIKH TO MINA ABDULLAH",
            "TRANSPORTATION SPECIAL LOWBED TRAILER",
            "TRANSPORTATION TO BURGAN",
            "TRANSPORTATION TO RAWDATAIN",
            "TRANSPORTATION TO RIG 801",
            "TRANSPORTATION TO RIG 802",
            "TRANSPORTATION TO UMM NIQA",
            "TRANSPORTATION-TRUCK HEADS",
            "TRANSPORTATION - TWO LOCATIONS",
            "TRUCK DETENTION",
            "TYPING CHARGES",
            "UAE BORDER CHARGES",
            "UAE CLEARANCE SERVICE CHARGE",
            "UAE CLEARANCE SERVICE CHARGES",
            "UAE EXPORT CLEARANCE",
            "UAE IMPORT CLEARANCE",
            "UAE IMPORT CLEARANCE (SILA & JAFZA)",
            "UAE IMPORT FORMALITIES -JAFZA BONDED BOE AND UAE SILA BORDER",
            "UAE RE-EXPORT CLEARANCE",
            "UAE RE EXPORT CLEARANCE (JAFZA & SILA)",
            "UAE TRANSLOADING",
            "UNIVERSAL MARINE COMPANY K.S.C",
            "UNLOADING AND RE-LOADING AFTER 2 DAYS FOR RE-EXPORT",
            "UNLOADING CHARGES",
            "UNPALLETIZED CARGO",
            "USAGE OF EXPORT LICENSE",
            "USAGE OF EXPORT LICENSE AND EXPORT DOCUMENTS",
            "USAGE OF IMPORT LICENSE",
            "USAGE OF IMPORT LICENSE AND EXPORT DOCUMENTS",
            "USING OUR LICENSE AND EPA APPROVAL CHARGES",
            "VAT CHARGES",
            "VEHICLE INSPECTION CHARGE",
            "WAREHOUSE STORAGE",
            "WAR RISK SURRCHARGE",
            "WEIGHING CHARGES",
            "WOODEN BOX REPAIR CHARGES"
        ];

        conn = await getDbConnection();
        await conn.beginTransaction();

        // Only INSERT new charges (NO DELETE)
        let insertedCount = 0;
        let skippedCount = 0;

        for (const chargeName of chargesList) {
            // Skip empty or null values
            if (!chargeName || chargeName.trim() === '') continue;

            // Check if charge already exists
            const existing = await conn.query(
                'SELECT id FROM description_charges WHERE charge_name = ?',
                [chargeName.trim()]
            );

            if (existing.length === 0) {
                // Only insert if it doesn't exist
                const chargeId = uuidv4();
                await conn.query(`
                    INSERT INTO description_charges (id, charge_name, is_active, created_at, updated_at)
                    VALUES (?, ?, TRUE, NOW(), NOW())
                `, [chargeId, chargeName.trim()]);
                insertedCount++;
            } else {
                skippedCount++;
            }
        }

        await conn.commit();

        console.log(`✅ Inserted ${insertedCount} new charge types`);
        console.log(`⏭️ Skipped ${skippedCount} existing charges`);
        console.log('📊 Total charges in database:', insertedCount + skippedCount);

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('❌ Error populating default charges:', error);
        throw error;
    } finally {
        if (conn) await conn.end();
    }
}

// Call this in initializeDatabase() after creating the table


async function migrateBillingDocumentFields() {
    let conn;
    try {
        console.log('🔄 Migrating billing document fields...');

        conn = await getDbConnection();

        // Check if columns exist
        const columns = await conn.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'job_cards' 
            AND TABLE_SCHEMA = DATABASE()
            AND COLUMN_NAME IN ('hbl', 'mbl', 'habw', 'mabw', 'road_waybill', 'multimodal_ref')
        `);

        const existingColumns = columns.map(col => col.COLUMN_NAME);
        const neededColumns = ['hbl', 'mbl', 'habw', 'mabw', 'road_waybill', 'multimodal_ref'];
        const missingColumns = neededColumns.filter(col => !existingColumns.includes(col));

        if (missingColumns.length > 0) {
            console.log(`Adding missing columns: ${missingColumns.join(', ')}`);

            for (const column of missingColumns) {
                try {
                    await conn.query(`
                        ALTER TABLE job_cards 
                        ADD COLUMN ${column} VARCHAR(100) DEFAULT NULL
                    `);
                    console.log(`✅ Added column: ${column}`);
                } catch (alterError) {
                    console.error(`Failed to add column ${column}:`, alterError.message);
                }
            }
        } else {
            console.log('✅ Billing document fields already exist');
        }

    } catch (error) {
        console.error('Migration error:', error);
    } finally {
        if (conn) await conn.end();
    }
}

async function ensureInvoiceItemColumns() {
    let conn;
    try {
        conn = await getDbConnection();

        const columns = await conn.query(`
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = 'invoice_items'
            AND TABLE_SCHEMA = DATABASE()
        `);

        if (!columns.some(column => column.COLUMN_NAME === 'charge_type')) {
            await conn.query(`
                ALTER TABLE invoice_items
                ADD COLUMN charge_type ENUM('required', 'marginal') DEFAULT 'required'
            `);
            console.log('Added column: invoice_items.charge_type');
        }
    } catch (error) {
        console.error('Invoice items migration error:', error);
        throw error;
    } finally {
        if (conn) await conn.end();
    }
}

async function migrateLocationFields() {
    let conn;
    try {
        console.log('🔄 Migrating location fields...');

        conn = await getDbConnection();

        // Check if port_arrival column exists
        const columns = await conn.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'job_cards' 
            AND TABLE_SCHEMA = DATABASE()
        `);

        const hasPortArrival = columns.some(col => col.COLUMN_NAME === 'port_arrival');
        const hasDepartureLocation = columns.some(col => col.COLUMN_NAME === 'departure_location');

        if (hasPortArrival && !hasDepartureLocation) {
            // Add new columns
            await conn.query(`
                ALTER TABLE job_cards 
                ADD COLUMN departure_location VARCHAR(200) DEFAULT 'Not Specified',
                ADD COLUMN arrival_location VARCHAR(200)
            `);

            // Migrate data from port_arrival to arrival_location
            await conn.query(`
                UPDATE job_cards 
                SET arrival_location = port_arrival,
                departure_location = 'Kuwait'
                WHERE arrival_location IS NULL
            `);
            console.log('✅ Location fields migrated successfully');
        } else {
            console.log('✅ Location fields already up to date');
        }

        const hasMasterRemarks = columns.some(col => col.COLUMN_NAME === 'master_remarks');
        if (!hasMasterRemarks) {
            await conn.query('ALTER TABLE job_cards ADD COLUMN master_remarks TEXT');
            console.log('✅ master_remarks field added successfully');
        } else {
            console.log('✅ master_remarks field already exists');
        }

    } catch (error) {
        console.error('Migration error:', error);
    } finally {
        if (conn) await conn.end();
    }
}


async function initializeJobCardNumbers() {
    try {
        const year = new Date().getFullYear();

        // Check if current year exists
        const existing = await executeQuery(
            'SELECT id FROM job_card_numbers WHERE year = ?',
            [year]
        );

        if (!existing.success || existing.data.length === 0) {
            // Get the highest job number from ALL existing job cards (not just current year)
            const maxJobResult = await executeQuery(`
                SELECT MAX(CAST(SUBSTRING_INDEX(job_no, '/', -1) AS UNSIGNED)) as max_number
                FROM job_cards 
                WHERE job_no LIKE 'EOE/%'
            `);

            let lastNumber = 0;
            if (maxJobResult.success && maxJobResult.data[0]?.max_number) {
                lastNumber = maxJobResult.data[0].max_number;
            }

            await executeQuery(
                `INSERT INTO job_card_numbers (year, last_number, current_year) VALUES (?, ?, TRUE)`,
                [year, lastNumber]
            );

            // Clear current_year flag from other years
            await executeQuery(
                'UPDATE job_card_numbers SET current_year = FALSE WHERE year != ?',
                [year]
            );

            console.log(`✅ Initialized job card numbers for year ${year} starting from ${lastNumber + 1}`);
        }

    } catch (error) {
        console.error('Job card numbers initialization error:', error);
    }
}

// Call this in initializeDatabase() after creating tables



async function generateInvoiceNumber() {
    let conn;
    try {
        const year = new Date().getFullYear();
        conn = await getDbConnection();

        // Start transaction to prevent race conditions
        await conn.beginTransaction();

        // 1. FIRST, CHECK FOR GAPS IN LAST 20 INVOICE NUMBERS
        const recentInvoices = await conn.query(`
            SELECT invoice_no 
            FROM job_cards 
            WHERE invoice_no LIKE 'INV/${year}/%'
            ORDER BY CAST(SUBSTRING_INDEX(invoice_no, '/', -1) AS UNSIGNED) DESC
            LIMIT 20
        `);

        let nextNumber;
        let foundGap = false;

        if (recentInvoices.length > 0) {
            // Extract numbers from invoice format: INV/2026/08231
            const numbers = recentInvoices
                .map(inv => {
                    const parts = inv.invoice_no.split('/');
                    return parseInt(parts[2]) || 0;
                })
                .sort((a, b) => a - b);

            console.log('Recent invoice numbers found:', numbers);

            // Find gaps in the sequence
            for (let i = 0; i < numbers.length - 1; i++) {
                const current = numbers[i];
                const next = numbers[i + 1];

                // If there's a gap (difference > 1), fill it
                if (next - current > 1) {
                    nextNumber = current + 1;
                    foundGap = true;
                    console.log(`✅ Found gap! Using ${nextNumber} instead of ${next}`);
                    break;
                }
            }

            // If no gaps found, get the max number
            if (!foundGap) {
                const maxNumber = Math.max(...numbers);
                nextNumber = maxNumber + 1;
                console.log(`No gaps found. Using next sequential number: ${nextNumber}`);
            }
        } else {
            // No invoices yet, start from base number
            nextNumber = 8231;
            console.log('No existing invoices. Starting from:', nextNumber);
        }

        // 2. Check if this number is already in use (double-check)
        const checkNumber = nextNumber.toString().padStart(5, '0');
        const checkInvoice = `INV/${year}/${checkNumber}`;

        const alreadyExists = await conn.query(
            'SELECT id FROM job_cards WHERE invoice_no = ?',
            [checkInvoice]
        );

        if (alreadyExists.length > 0) {
            console.warn(`⚠️ Number ${checkInvoice} already exists! Skipping to next.`);
            nextNumber++;
        }

        // 3. Check the invoice_numbers table - BUT DON'T OVERRIDE GAP FILLING
        const existingRecord = await conn.query(
            'SELECT last_number FROM invoice_numbers WHERE year = ? FOR UPDATE',
            [year]
        );

        if (existingRecord.length > 0) {
            const storedNumber = existingRecord[0].last_number;

            // ONLY override if we didn't find a gap AND our number is lower than stored
            if (!foundGap && nextNumber <= storedNumber) {
                nextNumber = storedNumber + 1;
                console.log(`Using stored number + 1: ${nextNumber} (stored: ${storedNumber})`);
            }

            // Update the stored number with our final choice
            await conn.query(
                'UPDATE invoice_numbers SET last_number = ? WHERE year = ?',
                [nextNumber, year]
            );
        } else {
            // Insert new record for this year
            await conn.query(
                `INSERT INTO invoice_numbers (
year, last_number
            ) VALUES (?, ?)`,
                [year, nextNumber]
            );
        }

        await conn.commit();

        // Format: INV/2026/08265 (5 digits padded with zeros)
        const formattedNumber = nextNumber.toString().padStart(5, '0');
        const invoiceNumber = `INV/${year}/${formattedNumber}`;

        console.log('✅ Generated invoice number:', invoiceNumber);

        return invoiceNumber;

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Invoice number generation error:', error);

        // Emergency fallback
        try {
            const year = new Date().getFullYear();
            const conn2 = await getDbConnection();

            // Try to find any gap in all invoice numbers
            const allInvoices = await conn2.query(`
                SELECT invoice_no
                FROM job_cards 
                WHERE invoice_no LIKE 'INV/${year}/%'
                ORDER BY CAST(SUBSTRING_INDEX(invoice_no, '/', -1) AS UNSIGNED)
            `);

            let nextNumber = 8231;

            if (allInvoices.length > 0) {
                // Convert to numbers
                const numbers = allInvoices.map(inv => {
                    const parts = inv.invoice_no.split('/');
                    return parseInt(parts[2]) || 0;
                });

                // Find first missing number
                for (let i = 8231; i <= 99999; i++) {
                    if (!numbers.includes(i)) {
                        nextNumber = i;
                        console.log(`Emergency gap fill: Using ${nextNumber}`);
                        break;
                    }
                }
            }

            await conn2.end();

            const formattedNumber = nextNumber.toString().padStart(5, '0');
            return `INV/${year}/${formattedNumber}`;

        } catch (fallbackError) {
            console.error('Emergency fallback also failed:', fallbackError);
            // Last resort: Use timestamp
            const year = new Date().getFullYear();
            const timestamp = Date.now() % 100000;
            return `INV/${year}/${timestamp.toString().padStart(5, '0')}`;
        }
    } finally {
        if (conn) await conn.end();
    }
}



async function migrateExistingCustomers() {
    let conn;
    try {
        console.log('🔄 Migrating existing customers from job cards...');

        conn = await getDbConnection();

        // Get all unique customers from job_cards
        /*
        const existingCustomers = await conn.query(`
            SELECT DISTINCT 
                customer_name as name,
                email,
                phone,
                customer_address as address,
                customer_ref_no as reference_number
            FROM job_cards 
            WHERE customer_name IS NOT NULL 
            AND customer_name != ''
            AND customer_name NOT IN (
                SELECT name FROM customers
            )
        `);

        console.log(`Found ${existingCustomers.length} customers to migrate`);

        for (const customer of existingCustomers) {
            const customerId = uuidv4();
            await conn.query(`
                INSERT INTO customers (
id, name, email, phone, address, reference_number, 
                    company, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                customerId,
                customer.name,
                customer.email || '',
                customer.phone || '',
                customer.address || '',
                customer.reference_number || '',
                '',
                new Date(),
                new Date()
            ]);
            console.log(`   ✅ Migrated: ${customer.name}`);
        }

        console.log('✅ Customer migration completed');
        */
    } catch (error) {
        console.error('Migration error:', error);
    } finally {
        if (conn) await conn.end();
    }
}

// ==================== HELPER FUNCTIONS ====================
const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

async function logAudit(userId, action, details = null, req = null) {
    try {
        await executeQuery(
            `INSERT INTO audit_logs (
user_id, action, details, ip_address, user_agent
            ) VALUES (?, ?, ?, ?, ?)`,
            [userId, action, details, req?.ip, req?.get('User-Agent')]
        );
    } catch (error) {
        console.error('Audit log error:', error);
    }
}

async function logEmail(recipient, subject, status, error = null) {
    try {
        await executeQuery(
            `INSERT INTO email_logs (
recipient, subject, status, error_message
            ) VALUES (?, ?, ?, ?)`,
            [recipient, subject, status, error]
        );
    } catch (error) {
        console.error('Email log error:', error);
    }
}

const sendEmail = async (to, subject, text, html, attachments = []) => {
    try {
        const transporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST || 'smtp.gmail.com',
            port: parseInt(process.env.EMAIL_PORT) || 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASSWORD
            },
            tls: {
                rejectUnauthorized: false
            }
        });

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to,
            subject,
            text,
            html,
            attachments
        };

        const info = await transporter.sendMail(mailOptions);
        await logEmail(to, subject, 'sent');

        console.log('📧 Email sent:', info.messageId);
        return info;
        return { success: true, messageId: info.messageId };

    } catch (error) {
        console.error('❌ Email failed:', error.message);
        await logEmail(to, subject, 'failed', error.message);
        return { success: false, error: error.message };
    }
};

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Al Eid POS Backend',
        version: '1.0.0',
        uptime: process.uptime()
    });
});

// Database test endpoint
app.get('/api/test-db', async (req, res) => {
    try {
        const result = await executeQuery('SELECT NOW() as timestamp, DATABASE() as db_name');

        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: 'Database connection failed',
                error: result.error
            });
        }

        res.json({
            success: true,
            message: 'Database connection successful',
            timestamp: result.data[0].timestamp,
            database: result.data[0].db_name,
            environment: process.env.NODE_ENV
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Database test failed',
            error: error.message
        });
    }
});

// ==================== USER ENDPOINTS ====================

// Check username availability
app.post('/api/check-username', async (req, res) => {
    try {
        const { username } = req.body;

        if (!username || username.length < 3) {
            return res.status(400).json({
                success: false,
                message: 'Username must be at least 3 characters'
            });
        }

        const result = await executeQuery(
            "SELECT id FROM users WHERE username = ?",
            [username]
        );

        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: 'Server error'
            });
        }

        if (result.data.length > 0) {
            return res.json({
                success: true,
                available: false,
                message: 'Username is already taken'
            });
        }

        return res.json({
            success: true,
            available: true,
            message: 'Username is available'
        });

    } catch (error) {
        console.error('Check username error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});
// Invoice creation endpoint
// Invoice creation endpoint - CORRECT: Replace charges instead of adding
app.post('/api/invoices/creation', async (req, res) => {
    let conn;
    try {
        const invoiceData = req.body;
        console.log('Received invoice data:', invoiceData);

        const {
            jobCardId,
            invoiceNumber,
            date,
            dueDate,
            notes,
            charges,
            subtotal,
            tax,
            total,
            advancePayment,
            createdBy
        } = invoiceData;

        // Validate required fields - only jobCardId is strictly required
        if (!jobCardId) {
            return res.status(400).json({
                success: false,
                message: 'Job card ID is required'
            });
        }

        conn = await getDbConnection();
        await conn.beginTransaction();

        // Step 1: Resolve invoice number — reuse existing or auto-generate
        let resolvedInvoiceNumber = invoiceNumber;
        if (!resolvedInvoiceNumber) {
            // Try to reuse the job card's existing invoice_no
            const jcRow = await conn.query(
                'SELECT job_no, invoice_no FROM job_cards WHERE id = ?',
                [jobCardId]
            );
            if (jcRow.length > 0 && jcRow[0].invoice_no && !jcRow[0].invoice_no.startsWith('PROF-')) {
                resolvedInvoiceNumber = jcRow[0].invoice_no;
                console.log('Reusing existing invoice number from job card:', resolvedInvoiceNumber);
            } else {
                // Generate a fresh invoice number
                const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
                const rand = Math.floor(1000 + Math.random() * 9000);
                resolvedInvoiceNumber = `INV-${dateStr}-${rand}`;
                console.log('Auto-generated invoice number:', resolvedInvoiceNumber);
            }
        }

        // Step 2: Get or create invoice record
        let invoiceId = null;

        // Check if invoice already exists with this invoice number first
        let existingInvoice = await conn.query(
            'SELECT id FROM invoices WHERE invoice_no = ?',
            [resolvedInvoiceNumber]
        );

        // Fallback: check by job_card_id (handles cases where invoice_no was changed)
        if (existingInvoice.length === 0) {
            existingInvoice = await conn.query(
                'SELECT id FROM invoices WHERE job_card_id = ? ORDER BY created_at DESC LIMIT 1',
                [jobCardId]
            );
        }

        if (existingInvoice.length > 0) {
            invoiceId = existingInvoice[0].id;
            console.log('Found existing invoice, will update:', invoiceId);

            // ✅ CRITICAL: Delete existing charges to avoid duplicates
            const deleteResult = await conn.query('DELETE FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
            console.log(`Deleted ${deleteResult.affectedRows} existing charges`);

            // Also delete existing advance payments to avoid duplicates
            await conn.query('DELETE FROM advance_payments WHERE invoice_id = ?', [invoiceId]);
            console.log('Deleted existing advance payments');

        } else {
            // Create new invoice
            invoiceId = uuidv4();

            await conn.query(`
                INSERT INTO invoices (
                    id, invoice_no, job_card_id,
                    date, due_date, subtotal, tax, total,
                    status, created_by, created_at, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                invoiceId,
                resolvedInvoiceNumber,
                jobCardId,
                date || new Date().toISOString().split('T')[0],
                dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                subtotal || 0,
                tax || 0,
                total || 0,
                'draft',
                createdBy || 'system',
                new Date(),
                notes || ''
            ]);

            console.log('Created new invoice:', invoiceId, 'with number:', resolvedInvoiceNumber);
        }

        // ✅ Step 2: Insert NEW charges (old ones already deleted)
        for (const charge of charges) {
            await conn.query(`
                INSERT INTO invoice_items (
invoice_id, description, charge_type,
                    quantity, unit, rate, amount,
                    created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                invoiceId,
                charge.description,
                charge.charge_type || 'required', // 'required' or 'marginal'
                charge.quantity,
                charge.unit,
                charge.rate,
                charge.amount,
                new Date()
            ]);
        }

        console.log(`Inserted ${charges.length} NEW charges into invoice_items (replaced old ones)`);

        // ✅ Step 3: Insert NEW advance payment (old ones already deleted)
        if (advancePayment && advancePayment.amount > 0) {
            const paymentId = uuidv4();

            await conn.query(`
                INSERT INTO advance_payments (
id, invoice_id, amount, payment_date, payment_method,
                    reference_number, notes, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                paymentId,
                invoiceId,
                parseFloat(advancePayment.amount) || 0,
                advancePayment.date || new Date().toISOString().split('T')[0],
                advancePayment.method || 'cash',
                advancePayment.reference || '',
                advancePayment.notes || '',
                createdBy || 'system',
                new Date()
            ]);

            console.log('Inserted new advance payment:', paymentId);
        }

        // ✅ Step 4: Update invoice totals (REPLACE, not ADD)
        const newSubtotal = parseFloat(subtotal) || 0;
        const newTax = parseFloat(tax) || 0;
        const newTotal = parseFloat(total) || 0;

        await conn.query(`
            UPDATE invoices 
            SET subtotal = ?, tax = ?, total = ?,
                status = 'draft',
                updated_at = NOW()
            WHERE id = ?
        `, [
            newSubtotal,
            newTax,
            newTotal,
            invoiceId
        ]);

        console.log('Updated invoice totals - New values:', {
            subtotal: newSubtotal,
            tax: newTax,
            total: newTotal
        });

        // Step 5: Update job card invoice number
        await conn.query(
            'UPDATE job_cards SET invoice_no = ? WHERE id = ?',
            [resolvedInvoiceNumber, jobCardId]
        );

        await conn.commit();

        // Log audit
        await logAudit(createdBy, 'INVOICE_CREATED',
            `Invoice ${resolvedInvoiceNumber} saved with ${charges.length} charges (replaced old ones)`, req);

        res.json({
            success: true,
            message: 'Invoice saved successfully',
            invoiceId: invoiceId,
            invoiceNumber: resolvedInvoiceNumber,
            totals: {
                subtotal: newSubtotal,
                tax: newTax,
                total: newTotal
            },
            chargeCount: charges.length
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Create invoice error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save invoice: ' + error.message,
            details: error.toString()
        });
    } finally {
        if (conn) await conn.end();
    }
});


// Get all charge types for dropdown
app.get('/api/charges/types', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();

        const chargeTypes = await conn.query(`
            SELECT id, charge_name as name 
            FROM description_charges 
            WHERE is_active = TRUE
            ORDER BY charge_name
        `);

        res.json({
            success: true,
            data: chargeTypes
        });

    } catch (error) {
        console.error('Get charge types error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get charge types'
        });
    } finally {
        if (conn) await conn.end();
    }
});
// Register new user (NO ADMIN APPROVAL NEEDED - DIRECT OTP VERIFICATION)
// Register new user (NO ADMIN APPROVAL NEEDED - DIRECT OTP VERIFICATION)
// Register new user (NO ADMIN APPROVAL NEEDED - DIRECT OTP VERIFICATION)
app.post('/api/register', async (req, res) => {
    let conn;
    try {
        const { name, email, gender, username, password, role = 'cashier' } = req.body;

        // Validation
        if (!name || !email || !gender || !username || !password) {
            return res.status(400).json({
                success: false,
                message: 'All fields are required'
            });
        }

        // Email validation
        if (!email.includes('@') || !email.includes('.')) {
            return res.status(400).json({
                success: false,
                message: 'Invalid email format'
            });
        }

        // Password validation
        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 6 characters'
            });
        }

        conn = await getDbConnection();

        // Check existing users
        const existingUser = await conn.query(
            "SELECT id FROM users WHERE username = ? OR email = ?",
            [username, email]
        );

        if (existingUser.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Username or email already exists'
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        const userId = uuidv4();

        // Generate OTP
        const fullOTP = generateOTP(); // 6-digit OTP

        // Split OTP: first 3 digits for user, last 3 digits for admin
        const userOTP = fullOTP.substring(0, 3); // First 3 digits
        const adminOTP = fullOTP.substring(3);   // Last 3 digits

        const verificationExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        // Start transaction
        await conn.beginTransaction();

        // Create user with 'pending' status
        await conn.query(`
            INSERT INTO users (id, name, email, gender, username, password, role, status, verification_code, verification_expiry)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `, [
            userId,
            name,
            email,
            gender,
            username,
            hashedPassword,
            role,
            fullOTP, // Store full OTP in database
            verificationExpiry
        ]);

        // Store full OTP in otp_store table
        await conn.query(`
            INSERT INTO otp_store (
user_id, otp, expires_at
            ) VALUES (?, ?, ?)
        `, [userId, fullOTP, verificationExpiry]);

        // Commit transaction
        await conn.commit();

        // Log audit
        await logAudit(userId, 'REGISTER', `User registered: ${username}`, req);

        // Send PARTIAL OTPs to user and admin (NON-BLOCKING)
        // ONLY ONE EMAIL TO USER - the split OTP
        (async () => {
            try {
                // 1. Send FIRST 3 DIGITS to USER (ONLY EMAIL THEY GET)
                const userHtml = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                        <div style="text-align: center; margin-bottom: 30px;">
                            <h2 style="color: #2c3e50;">🔐 Account Registration - Al Eid International Logistics</h2>
                        </div>
                        
                        <p>Dear <strong>${name}</strong>,</p>
                        
                        <p>Thank you for registering with Al Eid International Logistics Company!</p>
                        
                        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 25px 0; text-align: center;">
                            <h3 style="color: #2c3e50; margin-bottom: 15px;">Verification Code (First Part)</h3>
                            <div style="font-size: 42px; font-weight: bold; color: #007bff; letter-spacing: 8px; margin: 20px 0;">
                                ${userOTP}<span style="color: #999;">***</span>
                            </div>
                            <p style="color: #666; font-size: 14px;">First 3 digits of your 6-digit verification code</p>
                        </div>
                        
                                                <div style="background: white; 
                                    padding: 28px; 
                                    border-radius: 16px; 
                                    margin: 24px 0; 
                                    border: 2px solid #ffc107;
                                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
                                    position: relative;">
                            
                            <!-- Header with Icon -->
                            <div style="display: flex; align-items: center; margin-bottom: 20px;">
                                <div style="background: linear-gradient(135deg, #ffc107 0%, #ff9800 100%); 
                                            padding: 10px; 
                                            border-radius: 10px;
                                            margin-right: 16px;">
                                    <span style="color: white; font-size: 20px; font-weight: bold;">🔐</span>
                                </div>
                                <div>
                                    <h4 style="color: #2c3e50; margin: 0 0 4px 0; font-size: 20px; font-weight: 700;">
                                        Two-Part Verification
                                    </h4>
                                    <p style="color: #7f8c8d; margin: 0; font-size: 14px;">
                                        For enhanced security, your code is split between you and administrator
                                    </p>
                                </div>
                            </div>
                            
                            <!-- Steps -->
                            <div style="background: #f8f9fa; 
                                        padding: 20px; 
                                        border-radius: 12px;
                                        margin-bottom: 20px;">
                                
                                <div style="display: flex; margin-bottom: 16px; align-items: flex-start;">
                                    <div style="background: #0d6efd; 
                                                color: white; 
                                                width: 28px; 
                                                height: 28px; 
                                                border-radius: 50%; 
                                                display: flex; 
                                                align-items: center; 
                                                justify-content: center;
                                                margin-right: 12px;
                                                flex-shrink: 0;">
                                        <span style="font-size: 14px; font-weight: bold;">1</span>
                                    </div>
                                    <div>
                                        <p style="margin: 0; color: #2c3e50; font-weight: 600; font-size: 16px;">
                                            Your Part (Email)
                                        </p>
                                        <p style="margin: 4px 0 0 0; color: #6c757d; font-size: 14px;">
                                            You received <span style="color: #0d6efd; font-weight: 600;">first 3 digits</span> 
                                            in your email
                                        </p>
                                    </div>
                                </div>
                                
                                <div style="display: flex; margin-bottom: 16px; align-items: flex-start;">
                                    <div style="background: #dc3545; 
                                                color: white; 
                                                width: 28px; 
                                                height: 28px; 
                                                border-radius: 50%; 
                                                display: flex; 
                                                align-items: center; 
                                                justify-content: center;
                                                margin-right: 12px;
                                                flex-shrink: 0;">
                                        <span style="font-size: 14px; font-weight: bold;">2</span>
                                    </div>
                                    <div>
                                        <p style="margin: 0; color: #2c3e50; font-weight: 600; font-size: 16px;">
                                            Administrator's Part
                                        </p>
                                        <p style="margin: 4px 0 0 0; color: #6c757d; font-size: 14px;">
                                            Contact admin for <span style="color: #dc3545; font-weight: 600;">last 3 digits</span>
                                        </p>
                                    </div>
                                </div>
                                
                                <div style="display: flex; align-items: flex-start;">
                                    <div style="background: #198754; 
                                                color: white; 
                                                width: 28px; 
                                                height: 28px; 
                                                border-radius: 50%; 
                                                display: flex; 
                                                align-items: center; 
                                                justify-content: center;
                                                margin-right: 12px;
                                                flex-shrink: 0;">
                                        <span style="font-size: 14px; font-weight: bold;">3</span>
                                    </div>
                                    <div>
                                        <p style="margin: 0; color: #2c3e50; font-weight: 600; font-size: 16px;">
                                            Combine & Verify
                                        </p>
                                        <p style="margin: 4px 0 0 0; color: #6c757d; font-size: 14px;">
                                            Enter complete 6-digit code within 
                                            <span style="color: #dc3545; font-weight: 600;">5 minutes</span>
                                        </p>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- Important Note -->
                            <div style="background: #fff3cd; 
                                        padding: 16px; 
                                        border-radius: 10px;
                                        border-left: 4px solid #ffc107;">
                                <div style="display: flex; align-items: center; margin-bottom: 8px;">
                                    <span style="color: #856404; margin-right: 10px; font-size: 18px;">🛡️</span>
                                    <span style="color: #856404; font-weight: 600; font-size: 15px;">
                                        Security Notice
                                    </span>
                                </div>
                                <p style="color: #856404; margin: 0; font-size: 14px; line-height: 1.5;">
                                    Never share your complete verification code. Your administrator will provide 
                                    only the last 3 digits after identity verification.
                                </p>
                            </div>
                        </div>
                        
                        <div style="background-color: #e7f3ff; padding: 15px; border-radius: 6px; margin: 20px 0;">
                            <p><strong>⏱️ Code Expiry:</strong> ${verificationExpiry.toLocaleString()}</p>
                            <p><strong>👤 Your Username:</strong> ${username}</p>
                            <p><strong>📧 Your Email:</strong> ${email}</p>
                        </div>
                        
                        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0; text-align: center; color: #666; font-size: 12px;">
                            <p>This is an automated email. Please do not reply.</p>
                            <p>If you did not create this account, please ignore this email or contact support immediately.</p>
                            <p>© ${new Date().getFullYear()} Al Eid International Logistics Company. All rights reserved.</p>
                        </div>
                    </div>
                `;

                await sendEmail(
                    email,
                    `Your Verification Code: ${userOTP}*** - Al Eid International Logistics`,
                    `
ACCOUNT REGISTRATION - AL EID INTERNATIONAL LOGISTICS

Hello ${name},

Thank you for registering with Al Eid International Logistics Company!

YOUR VERIFICATION CODE (FIRST PART): ${userOTP}***

IMPORTANT INSTRUCTIONS:
1. You have received the FIRST 3 DIGITS of your verification code
2. Contact your system administrator to obtain the remaining 3 digits
3. Combine both parts to get your complete 6-digit verification code
4. Enter the complete code on the verification page within 5 minutes

DETAILS:
- Username: ${username}
- Email: ${email}
- Code Expiry: ${verificationExpiry.toLocaleString()}

SECURITY NOTE:
Never share the complete verification code with anyone. Your administrator will provide only the last 3 digits.

If you did not create this account, please contact support immediately.

© ${new Date().getFullYear()} Al Eid International Logistics Company.
                    `,
                    userHtml
                );

                console.log(`✅ User OTP email sent to: ${email} (First 3 digits: ${userOTP}***)`);

            } catch (emailError) {
                console.error('User email sending error:', emailError);
                // Log but don't fail the registration
                await logAudit(userId, 'EMAIL_SEND_FAILED', `Failed to send OTP email to user: ${emailError.message}`, req);
            }
        })();

        // Send admin email SEPARATELY (also non-blocking)
        (async () => {
            try {
                // 2. Send LAST 3 DIGITS to ADMIN
                const adminHtml = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                        <div style="text-align: center; margin-bottom: 30px; background-color: #f8d7da; padding: 15px; border-radius: 8px;">
                            <h2 style="color: #721c24;">🆕 New User Registration - Admin Action Required</h2>
                        </div>
                        
                        <p><strong>A new user has registered and requires verification:</strong></p>
                        
                        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                            <h3 style="color: #2c3e50;">👤 User Details:</h3>
                            <table style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>Full Name:</strong></td>
                                    <td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${name}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>Email:</strong></td>
                                    <td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${email}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>Username:</strong></td>
                                    <td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${username}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>Role Requested:</strong></td>
                                    <td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${role}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px; border-bottom: 1px solid #dee2e6;"><strong>Registration Time:</strong></td>
                                    <td style="padding: 8px; border-bottom: 1px solid #dee2e6;">${new Date().toLocaleString()}</td>
                                </tr>
                            </table>
                        </div>
                        
                        <div style="background-color: #fff3cd; padding: 20px; border-radius: 8px; margin: 25px 0; text-align: center;">
                            <h3 style="color: #856404;">🔢 Verification Code - Last 3 Digits</h3>
                            <div style="font-size: 36px; font-weight: bold; color: #dc3545; letter-spacing: 8px; margin: 20px 0;">
                                <span style="color: #999;">***</span>${adminOTP}
                            </div>
                            <p style="color: #666;"><strong>Complete OTP:</strong> ${userOTP}${adminOTP}</p>
                        </div>
                        
                        <div style="background-color: #d1ecf1; padding: 15px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #0c5460;">
                            <h4 style="color: #0c5460; margin-top: 0;">📋 Administrator Instructions:</h4>
                            <ol>
                                <li>The user has received the first 3 digits: <strong>${userOTP}***</strong></li>
                                <li>Provide the user with ONLY the last 3 digits: <strong>${adminOTP}</strong></li>
                                <li>User must enter the complete code: <strong>${userOTP}${adminOTP}</strong></li>
                                <li>Code expires: <strong>${verificationExpiry.toLocaleString()}</strong></li>
                            </ol>
                        </div>
                        
                        <div style="background-color: #f8d7da; padding: 15px; border-radius: 6px; margin: 20px 0;">
                            <p><strong>⚠️ SECURITY WARNING:</strong></p>
                            <ul style="color: #721c24;">
                                <li>Never share the complete OTP with anyone</li>
                                <li>Verify the user's identity before providing the last 3 digits</li>
                                <li>Destroy this email after the user is verified</li>
                            </ul>
                        </div>
                        
                        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0; text-align: center; color: #666; font-size: 12px;">
                            <p>This is an automated notification for administrators only.</p>
                            <p>© ${new Date().getFullYear()} Al Eid International Logistics Company.</p>
                        </div>
                    </div>
                `;

                await sendEmail(
                    process.env.ADMIN_EMAIL || 'admin@al-eid-logistics.com',
                    `[ACTION REQUIRED] New User: ${name} - Verification Code Part 2: ${adminOTP}`,
                    `
NEW USER REGISTRATION - ADMIN ACTION REQUIRED

User Details:
- Name: ${name}
- Email: ${email}
- Username: ${username}
- Role Requested: ${role}
- Registration Time: ${new Date().toLocaleString()}

VERIFICATION CODE:
- User has received: ${userOTP}*** (first 3 digits)
- You must provide: ${adminOTP} (last 3 digits)
- Complete OTP: ${userOTP}${adminOTP}
- Expires: ${verificationExpiry.toLocaleString()}

INSTRUCTIONS:
1. Verify the user's identity
2. Provide ONLY the last 3 digits: ${adminOTP}
3. User will combine with their part: ${userOTP} + ${adminOTP}
4. User enters complete code: ${userOTP}${adminOTP}

SECURITY:
- Never share the complete OTP
- Verify user identity first
- Destroy this message after verification
                    `,
                    adminHtml
                );

                console.log(`✅ Admin OTP email sent (Last 3 digits: ***${adminOTP})`);

            } catch (adminEmailError) {
                console.error('Admin email sending error:', adminEmailError);
                // Log but don't fail registration
                await logAudit(userId, 'ADMIN_EMAIL_FAILED', `Failed to send admin email: ${adminEmailError.message}`, req);
            }
        })();

        // Send immediate response
        res.json({
            success: true,
            message: 'Registration successful! Check your email for the first part of your verification code.',
            userId,
            username,
            email,
            requiresVerification: true,
            note: 'You have received the first 3 digits via email. Contact your administrator to get the remaining 3 digits.',
            otpFormat: 'First 3 digits sent to your email, last 3 digits with administrator'
        });

    } catch (error) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (rollbackError) {
                console.error('Rollback error:', rollbackError);
            }
        }
        console.error('Registration error:', error);
        res.status(500).json({
            success: false,
            message: 'Registration failed: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});




// Send verification code
// Send verification code (with split OTP)
// Send verification code (with split OTP)
app.post('/api/send-verification', async (req, res) => {
    let conn;
    try {
        const { username } = req.body;

        if (!username) {
            return res.status(400).json({
                success: false,
                message: 'Username is required'
            });
        }

        conn = await getDbConnection();

        // Get user
        const user = await conn.query(
            "SELECT id, name, email FROM users WHERE username = ? AND status = 'pending'",
            [username]
        );

        if (user.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found or already verified'
            });
        }

        // Generate new OTP
        const fullOTP = generateOTP();

        // Split OTP
        const userOTP = fullOTP.substring(0, 3); // First 3 digits
        const adminOTP = fullOTP.substring(3);   // Last 3 digits

        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        // Update user verification code
        await conn.query(
            "UPDATE users SET verification_code = ?, verification_expiry = ? WHERE username = ?",
            [fullOTP, expiresAt, username]
        );

        // Update OTP store
        await conn.query(
            "DELETE FROM otp_store WHERE user_id = ?",
            [user[0].id]
        );

        await conn.query(
            `INSERT INTO otp_store (
user_id, otp, expires_at
            ) VALUES (?, ?, ?)`,
            [user[0].id, fullOTP, expiresAt]
        );

        // Send emails with split OTPs (NON-BLOCKING)
        (async () => {
            try {
                // Send first 3 digits to user
                const userHtml = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                        <h2 style="text-align: center; color: #2c3e50;">🔄 New Verification Code Requested</h2>
                        <p>Hello ${user[0].name},</p>
                        <p>You have requested a new verification code for Al Eid POS System.</p>
                        
                        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
                            <h3>Your New Verification Code (First Part)</h3>
                            <div style="font-size: 36px; font-weight: bold; color: #007bff; letter-spacing: 8px; margin: 20px 0;">
                                ${userOTP}<span style="color: #999;">***</span>
                            </div>
                            <p style="color: #666;">Contact your administrator for the remaining 3 digits</p>
                        </div>
                        
                        <p><strong>Expires:</strong> ${expiresAt.toLocaleString()}</p>
                    </div>
                `;

                await sendEmail(
                    user[0].email,
                    'New Verification Code Requested - Al Eid POS System',
                    `Your new verification code (first part) is: ${userOTP}***\nContact admin for remaining digits.\nExpires: ${expiresAt.toLocaleString()}`,
                    userHtml
                );

                console.log(`✅ Resent OTP to user: ${user[0].email} (First 3 digits: ${userOTP}***)`);

            } catch (emailError) {
                console.error('Resend email error:', emailError);
            }
        })();

        // Send admin notification (optional)
        (async () => {
            try {
                const adminHtml = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h2 style="color: #dc3545;">🔄 Verification Code Reset Request</h2>
                        <p><strong>User ${user[0].name} requested a new verification code.</strong></p>
                        <p><strong>Last 3 digits:</strong> ${adminOTP}</p>
                        <p><strong>Complete OTP:</strong> ${userOTP}${adminOTP}</p>
                    </div>
                `;

                await sendEmail(
                    process.env.ADMIN_EMAIL || 'admin@al-eid-logistics.com',
                    `Verification Reset: ${user[0].name} - Last 3 Digits: ${adminOTP}`,
                    `User ${user[0].name} requested new verification code.\nLast 3 digits: ${adminOTP}`,
                    adminHtml
                );

            } catch (adminEmailError) {
                console.error('Admin notification error:', adminEmailError);
            }
        })();

        await logAudit(user[0].id, 'VERIFICATION_RESENT', `New verification code sent to ${user[0].email}`, req);

        res.json({
            success: true,
            message: 'New verification code sent. Check your email for the first 3 digits.'
        });

    } catch (error) {
        console.error('Send verification error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send verification code'
        });
    } finally {
        if (conn) await conn.end();
    }
});





// Verify OTP (No admin approval needed - direct activation)
// Verify OTP (No admin approval needed - direct activation)
app.post('/api/verify-otp', async (req, res) => {
    let conn;
    try {
        const { username, otp } = req.body;

        if (!username || !otp) {
            return res.status(400).json({
                success: false,
                message: 'Username and OTP are required'
            });
        }

        conn = await getDbConnection();

        // Get user
        const user = await conn.query(
            "SELECT id, name, email, verification_code, verification_expiry FROM users WHERE username = ? AND status = 'pending'",
            [username]
        );

        if (user.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found or already verified'
            });
        }

        // Check OTP from user table
        if (!user[0].verification_code || user[0].verification_code !== otp) {
            return res.status(400).json({
                success: false,
                message: 'Invalid verification code'
            });
        }

        // Check expiration
        if (new Date(user[0].verification_expiry) < new Date()) {
            return res.status(400).json({
                success: false,
                message: 'Verification code has expired'
            });
        }

        // Start transaction
        await conn.beginTransaction();

        // Activate user directly (NO ADMIN APPROVAL NEEDED)
        await conn.query(`
            UPDATE users 
            SET status = 'active', 
                is_verified = TRUE, 
                verified_at = NOW(),
                verification_code = NULL,
                verification_expiry = NULL
            WHERE username = ?
        `, [username]);

        // Clear OTP from otp_store
        await conn.query(
            "DELETE FROM otp_store WHERE user_id = ?",
            [user[0].id]
        );

        await conn.commit();

        // Log
        await logAudit(user[0].id, 'ACCOUNT_VERIFIED', 'Account verified and activated via OTP', req);

        // SEND BEAUTIFUL WELCOME EMAIL AFTER SUCCESSFUL VERIFICATION
        (async () => {
            try {
                const welcomeHtml = `
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Welcome to Al Eid International Logistics</title>
                        <style>
                            @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&family=Montserrat:wght@400;500;600;700&display=swap');
                            
                            body {
                                font-family: 'Poppins', sans-serif;
                                margin: 0;
                                padding: 0;
                                background-color: #f5f7fa;
                            }
                            
                            .email-container {
                                max-width: 600px;
                                margin: 0 auto;
                                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                border-radius: 20px;
                                overflow: hidden;
                                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
                            }
                            
                            .header {
                                text-align: center;
                                padding: 50px 40px 30px;
                                background: white;
                                position: relative;
                            }
                            
                            .logo {
                                width: 120px;
                                height: 120px;
                                margin: 0 auto 25px;
                                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                border-radius: 50%;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3);
                            }
                            
                            .logo-text {
                                color: white;
                                font-family: 'Montserrat', sans-serif;
                                font-size: 24px;
                                font-weight: 700;
                                letter-spacing: 1px;
                            }
                            
                            h1 {
                                font-family: 'Montserrat', sans-serif;
                                color: #2c3e50;
                                font-size: 36px;
                                font-weight: 700;
                                margin: 0 0 15px;
                                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                -webkit-background-clip: text;
                                -webkit-text-fill-color: transparent;
                            }
                            
                            .subtitle {
                                color: #7f8c8d;
                                font-size: 18px;
                                font-weight: 400;
                                margin-bottom: 30px;
                            }
                            
                            .content {
                                padding: 50px 40px;
                                background: white;
                            }
                            
                            .welcome-box {
                                background: linear-gradient(135deg, #f6f9ff 0%, #f0f4ff 100%);
                                border-radius: 15px;
                                padding: 40px;
                                text-align: center;
                                margin-bottom: 40px;
                                border: 2px solid rgba(102, 126, 234, 0.1);
                                position: relative;
                            }
                            
                            .welcome-box:before {
                                content: '';
                                position: absolute;
                                top: -2px;
                                left: -2px;
                                right: -2px;
                                bottom: -2px;
                                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                border-radius: 17px;
                                z-index: -1;
                                opacity: 0.1;
                            }
                            
                            .welcome-icon {
                                font-size: 64px;
                                margin-bottom: 25px;
                                color: #667eea;
                            }
                            
                            .welcome-message {
                                font-size: 22px;
                                color: #2c3e50;
                                font-weight: 500;
                                line-height: 1.6;
                                margin-bottom: 30px;
                            }
                            
                            .highlight {
                                color: #667eea;
                                font-weight: 600;
                            }
                            
                            .user-details {
                                background: #f8fafc;
                                border-radius: 12px;
                                padding: 30px;
                                margin: 40px 0;
                                border-left: 5px solid #667eea;
                            }
                            
                            .detail-row {
                                display: flex;
                                justify-content: space-between;
                                padding: 12px 0;
                                border-bottom: 1px solid #eef2f7;
                            }
                            
                            .detail-row:last-child {
                                border-bottom: none;
                            }
                            
                            .detail-label {
                                color: #64748b;
                                font-weight: 500;
                            }
                            
                            .detail-value {
                                color: #1e293b;
                                font-weight: 600;
                            }
                            
                            .cta-button {
                                display: inline-block;
                                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                color: white;
                                padding: 18px 45px;
                                text-decoration: none;
                                border-radius: 50px;
                                font-weight: 600;
                                font-size: 18px;
                                letter-spacing: 0.5px;
                                margin: 30px 0;
                                box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3);
                                transition: all 0.3s ease;
                            }
                            
                            .cta-button:hover {
                                transform: translateY(-3px);
                                box-shadow: 0 15px 40px rgba(102, 126, 234, 0.4);
                            }
                            
                            .features {
                                display: grid;
                                grid-template-columns: repeat(2, 1fr);
                                gap: 25px;
                                margin: 40px 0;
                            }
                            
                            .feature {
                                background: white;
                                padding: 25px;
                                border-radius: 12px;
                                text-align: center;
                                box-shadow: 0 5px 20px rgba(0, 0, 0, 0.05);
                                transition: transform 0.3s ease;
                            }
                            
                            .feature:hover {
                                transform: translateY(-5px);
                            }
                            
                            .feature-icon {
                                font-size: 32px;
                                margin-bottom: 15px;
                                color: #667eea;
                            }
                            
                            .feature-title {
                                font-weight: 600;
                                color: #2c3e50;
                                margin-bottom: 10px;
                            }
                            
                            .feature-desc {
                                color: #64748b;
                                font-size: 14px;
                                line-height: 1.5;
                            }
                            
                            .footer {
                                text-align: center;
                                padding: 40px;
                                background: #1a1a2e;
                                color: white;
                                border-radius: 0 0 20px 20px;
                            }
                            
                            .footer-logo {
                                font-family: 'Montserrat', sans-serif;
                                font-size: 24px;
                                font-weight: 700;
                                color: white;
                                margin-bottom: 20px;
                                letter-spacing: 1px;
                            }
                            
                            .contact-info {
                                color: #b0b7c3;
                                font-size: 14px;
                                line-height: 1.8;
                                margin-bottom: 25px;
                            }
                            
                            .social-icons {
                                display: flex;
                                justify-content: center;
                                gap: 20px;
                                margin: 25px 0;
                            }
                            
                            .social-icon {
                                width: 40px;
                                height: 40px;
                                background: rgba(255, 255, 255, 0.1);
                                border-radius: 50%;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                color: white;
                                text-decoration: none;
                                transition: all 0.3s ease;
                            }
                            
                            .social-icon:hover {
                                background: #667eea;
                                transform: translateY(-3px);
                            }
                            
                            .copyright {
                                color: #8a94a6;
                                font-size: 12px;
                                margin-top: 30px;
                                padding-top: 20px;
                                border-top: 1px solid rgba(255, 255, 255, 0.1);
                            }
                            
                            @media (max-width: 600px) {
                                .features {
                                    grid-template-columns: 1fr;
                                }
                                
                                .content, .header {
                                    padding: 30px 20px;
                                }
                                
                                h1 {
                                    font-size: 28px;
                                }
                            }
                        </style>
                    </head>
                    <body>
                        <div class="email-container">
                            <!-- Header -->
                            <div class="header">
                                <div class="logo">
                                    <div class="logo-text">ALEID</div>
                                </div>
                                <h1>🎉 Welcome Aboard!</h1>
                                <p class="subtitle">Your journey with Al Eid International Logistics begins now</p>
                            </div>
                            
                            <!-- Main Content -->
                            <div class="content">
                                <!-- Welcome Message -->
                                <div class="welcome-box">
                                    <div class="welcome-icon">🚀</div>
                                    <p class="welcome-message">
                                        Hello <span class="highlight">${user[0].name}</span>,<br>
                                        Congratulations! Your account has been successfully verified and activated.
                                    </p>
                                </div>
                                
                                <!-- User Details -->
                                <div class="user-details">
                                    <div class="detail-row">
                                        <span class="detail-label">Account Status</span>
                                        <span class="detail-value" style="color: #10b981;">✅ Active & Verified</span>
                                    </div>
                                    <div class="detail-row">
                                        <span class="detail-label">Username</span>
                                        <span class="detail-value">${username}</span>
                                    </div>
                                    <div class="detail-row">
                                        <span class="detail-label">Email</span>
                                        <span class="detail-value">${user[0].email}</span>
                                    </div>
                                    <div class="detail-row">
                                        <span class="detail-label">Verification Date</span>
                                        <span class="detail-value">${new Date().toLocaleDateString('en-US', {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                })}</span>
                                    </div>
                                </div>
                                
                                <!-- Call to Action -->
                                <div style="text-align: center; margin: 40px 0;">
                                    <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" class="cta-button">
                                        🚀 Access Your Dashboard
                                    </a>
                                    <p style="color: #64748b; font-size: 14px; margin-top: 15px;">
                                        Click the button above to login and start using our system
                                    </p>
                                </div>
                                
                                <!-- Features -->
                                <h3 style="text-align: center; color: #2c3e50; margin-bottom: 30px; font-family: 'Montserrat', sans-serif;">
                                    ✨ What You Can Do Now
                                </h3>
                                <div class="features">
                                    <div class="feature">
                                        <div class="feature-icon">📋</div>
                                        <div class="feature-title">Create Job Cards</div>
                                        <div class="feature-desc">Manage shipments, track status, and generate documents</div>
                                    </div>
                                    <div class="feature">
                                        <div class="feature-icon">🧾</div>
                                        <div class="feature-title">Generate Invoices</div>
                                        <div class="feature-desc">Create professional invoices with automatic calculations</div>
                                    </div>
                                    <div class="feature">
                                        <div class="feature-icon">📊</div>
                                        <div class="feature-title">View Reports</div>
                                        <div class="feature-desc">Access real-time analytics and business insights</div>
                                    </div>
                                    <div class="feature">
                                        <div class="feature-icon">👥</div>
                                        <div class="feature-title">Team Collaboration</div>
                                        <div class="feature-desc">Work seamlessly with your team members</div>
                                    </div>
                                </div>
                                
                                <!-- Tips -->
                                <div style="background: #f0f9ff; border-radius: 12px; padding: 25px; margin: 40px 0; border-left: 5px solid #0ea5e9;">
                                    <h4 style="color: #0369a1; margin-top: 0; font-family: 'Montserrat', sans-serif;">💡 Quick Tips to Get Started</h4>
                                    <ul style="color: #0c4a6e; line-height: 1.8; padding-left: 20px;">
                                        <li>Complete your profile with additional details</li>
                                        <li>Explore the dashboard to familiarize yourself</li>
                                        <li>Check out the tutorial section for guidance</li>
                                        <li>Contact support if you need any assistance</li>
                                    </ul>
                                </div>
                            </div>
                            
                            <!-- Footer -->
                            <div class="footer">
                                <div class="footer-logo">AL EID INTERNATIONAL LOGISTICS</div>
                                <div class="contact-info">
                                    <p>📍 Office 10, M Floor, Tala Mall, Street 79, Plot 20, Dajeej, 80000, Farwaniya, Kuwait</p>
                                    <p>📞 ${process.env.COMPANY_PHONE || '+965 24311005/6'} | ✉️ ${process.env.COMPANY_EMAIL || 'sales@aleidlogistics.com'}</p>
                                </div>
                                
                                <div class="social-icons">
                                    <a href="#" class="social-icon">f</a>
                                    <a href="#" class="social-icon">in</a>
                                    <a href="#" class="social-icon">tw</a>
                                    <a href="#" class="social-icon">ig</a>
                                </div>
                                
                                <div class="copyright">
                                    © ${new Date().getFullYear()} Al Eid International Logistics Company. All rights reserved.<br>
                                    This is an automated message. Please do not reply to this email.
                                </div>
                            </div>
                        </div>
                    </body>
                    </html>
                `;

                const plainText = `
🎉 WELCOME TO AL EID INTERNATIONAL LOGISTICS!

Hello ${user[0].name},

Congratulations! Your account has been successfully verified and activated.

ACCOUNT DETAILS:
- Username: ${username}
- Email: ${user[0].email}
- Status: ✅ Active & Verified
- Verification Date: ${new Date().toLocaleDateString()}

GET STARTED:
Login to your account at: ${process.env.FRONTEND_URL || 'http://localhost:3000'}

WHAT YOU CAN DO:
📋 Create Job Cards - Manage shipments and track status
🧾 Generate Invoices - Create professional invoices
📊 View Reports - Access real-time analytics
👥 Team Collaboration - Work seamlessly with your team

QUICK TIPS:
1. Complete your profile with additional details
2. Explore the dashboard to familiarize yourself
3. Check out the tutorial section for guidance
4. Contact support if you need any assistance

COMPANY INFORMATION:
📍 Office 10, M Floor, Tala Mall, Street 79, Plot 20, Dajeej, 80000, Farwaniya, Kuwait
📞 ${process.env.COMPANY_PHONE || '+965 24311005/6'}
✉️ ${process.env.COMPANY_EMAIL || 'sales@aleidlogistics.com'}

Thank you for joining Al Eid International Logistics!
We're excited to have you on board.

© ${new Date().getFullYear()} Al Eid International Logistics Company.
This is an automated message. Please do not reply.
                `;

                await sendEmail(
                    user[0].email,
                    '🎉 Welcome to Al Eid International Logistics - Your Account is Now Active!',
                    plainText,
                    welcomeHtml
                );

                console.log(`✅ Welcome email sent to: ${user[0].email}`);

            } catch (emailError) {
                console.error('Welcome email sending error:', emailError);
                // Log but don't fail verification
                await logAudit(user[0].id, 'WELCOME_EMAIL_FAILED',
                    `Failed to send welcome email: ${emailError.message}`, req);
            }
        })();

        res.json({
            success: true,
            message: 'Account verified successfully! You can now login.',
            user: {
                id: user[0].id,
                name: user[0].name,
                email: user[0].email,
                username: username
            }
        });

    } catch (error) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (rollbackError) {
                console.error('Rollback error:', rollbackError);
            }
        }
        console.error('Verification error:', error);
        res.status(500).json({
            success: false,
            message: 'Verification failed: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});



// User login
app.post('/api/login', async (req, res) => {
    let conn;
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username and password required'
            });
        }

        conn = await getDbConnection();

        // Get user
        const user = await conn.query(
            "SELECT * FROM users WHERE username = ?",
            [username]
        );

        if (user.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Check account status
        if (user[0].account_locked) {
            return res.status(401).json({
                success: false,
                message: 'Account is locked. Please contact administrator.'
            });
        }

        if (user[0].status !== 'active') {
            return res.status(401).json({
                success: false,
                message: `Account is ${user[0].status}. Please verify your account first.`
            });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user[0].password);
        if (!validPassword) {
            // Increment login attempts
            await conn.query(
                "UPDATE users SET login_attempts = login_attempts + 1 WHERE username = ?",
                [username]
            );

            // Check and lock if needed
            const attemptsResult = await conn.query(
                "SELECT login_attempts FROM users WHERE username = ?",
                [username]
            );

            if (attemptsResult[0].login_attempts >= 5) {
                await conn.query(
                    "UPDATE users SET account_locked = TRUE WHERE username = ?",
                    [username]
                );
                await logAudit(user[0].id, 'ACCOUNT_LOCKED', 'Account locked due to failed login attempts', req);
            }

            await logAudit(user[0].id, 'LOGIN_FAILED', 'Invalid password attempt', req);

            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Reset login attempts
        await conn.query(
            "UPDATE users SET login_attempts = 0, last_login = NOW() WHERE username = ?",
            [username]
        );

        // Generate JWT token
        const token = jwt.sign(
            {
                userId: user[0].id,
                username: user[0].username,
                role: user[0].role,
                email: user[0].email
            },
            process.env.JWT_SECRET || 'fallback_secret_key',
            { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
        );

        // Create session
        await conn.query(`
            INSERT INTO sessions (user_id, token, expires_at, ip_address, user_agent)
            VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR), ?, ?)
        `, [user[0].id, token, req.ip, req.get('User-Agent')]);

        // Log successful login
        await logAudit(user[0].id, 'LOGIN_SUCCESS', 'User logged in successfully', req);

        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                id: user[0].id,
                name: user[0].name,
                email: user[0].email,
                username: user[0].username,
                role: user[0].role
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Login failed: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// ==================== ADMIN ENDPOINTS (Optional - for user management) ====================
// Middleware to verify admin
const verifyAdmin = async (req, res, next) => {
    let conn;
    try {
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Access denied. No token provided.'
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_key');

        conn = await getDbConnection();

        // Check if user is admin
        const userResult = await conn.query(
            "SELECT role FROM users WHERE id = ?",
            [decoded.userId]
        );

        if (userResult.length === 0 || userResult[0].role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Admin privileges required.'
            });
        }

        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Invalid token'
        });
    } finally {
        if (conn) await conn.end();
    }
};


// Add this endpoint to your backend
app.get('/api/jobcards/check-number', async (req, res) => {
    let conn;
    try {
        const { jobNo } = req.query;

        if (!jobNo) {
            return res.json({ exists: false });
        }

        conn = await getDbConnection();

        const existing = await conn.query(
            'SELECT id FROM job_cards WHERE job_no = ?',
            [jobNo]
        );

        res.json({
            exists: existing.length > 0
        });

    } catch (error) {
        console.error('Check job number error:', error);
        res.json({ exists: false });
    } finally {
        if (conn) await conn.end();
    }
});


// Get all users
app.get('/api/admin/users', verifyAdmin, async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        const users = await conn.query(`
            SELECT id, name, email, gender, username, role, status, 
                   created_at, verified_at, last_login
            FROM users 
            ORDER BY created_at DESC
        `);

        res.json({
            success: true,
            count: users.length,
            users
        });

    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get users'
        });
    } finally {
        if (conn) await conn.end();
    }
});


// ==================== JOB CARD ENDPOINTS ====================

// GET /api/jobcards/next-number - Use the proper job number generator
// GET /api/jobcards/next-number - Returns the NEXT number WITHOUT incrementing
// GET /api/jobcards/next-number - Returns the NEXT number
// GET /api/jobcards/next-number - Returns preview number
app.get('/api/jobcards/next-number', async (req, res) => {
    let conn;
    try {
        let { mode = 'ROA', type = 'I' } = req.query;
        
        // Convert frontend values
        const modeMap = {
            'ROAD': 'ROA',
            'ROA': 'ROA',
            'AIR': 'AIR',
            'SEA': 'SEA',
            'MUL': 'MUL',
            'SJ': 'SJ',      // ← ADD SJ
            'SERVICE': 'SJ', // ← ADD SJ alias
            'SERVICE JOB': 'SJ' // ← ADD SJ alias
        };
        
        const typeMap = {
            'IMPORT': 'I',
            'EXPORT': 'E',
            'DOMESTIC': 'D',
            'SJ': 'SJ',
            'SERVICE': 'SJ',
            'I': 'I',
            'E': 'E',
            'D': 'D'
        };

        mode = modeMap[mode] || 'ROA';
        type = typeMap[type] || 'I';

        const year = new Date().getFullYear();
        conn = await getDbConnection();

        let prefix = "";
        switch (mode) {
            case 'ROA': prefix = 'ROA'; break;
            case 'AIR': prefix = 'AIR'; break;
            case 'SEA': prefix = 'SEA'; break;
            case 'MUL': prefix = 'MUL'; break;
            case 'SJ': prefix = 'SJ'; break;  // ← ADD SJ
            default: prefix = 'JC';
        }

        let typeSuffix = "";
        let typeLetter = "";
        switch (type) {
            case 'I': typeSuffix = '-I-'; typeLetter = 'I'; break;
            case 'E': typeSuffix = '-E-'; typeLetter = 'E'; break;
            case 'D': typeSuffix = '-D-'; typeLetter = 'D'; break;
            case 'SJ':
            case 'SERVICE':
                typeSuffix = '-';
                typeLetter = '';
                break;
            default: typeSuffix = '-';
        }

        // Custom starting numbers
        const startingNumbers = {
            'ROA-I': 45785,
            'ROA-E': 50000,
            'ROA-D': 60000,
            'AIR-I': 1000,
            'AIR-E': 2000,
            'AIR-D': 3000,
            'SEA-I': 40000,
            'SEA-E': 844512,
            'SEA-D': 900000,
            'MUL-I': 3000,
            'MUL-E': 4000,
            'MUL-D': 5000,
            'SJ-': 1,  // ← ADD SJ starting number
        };

        let combinationKey = `${prefix}-${typeLetter}`;
        if (!typeLetter) {
            combinationKey = `${prefix}-`;
        }
        
        let startNumber = startingNumbers[combinationKey] || 1;

        // Construct search pattern
        let searchPattern;
        if (prefix === 'SJ') {
            searchPattern = `SJ-${year}-%`;
        } else {
            searchPattern = `${prefix}${typeSuffix}${year}-%`;
        }

        const maxJobResult = await conn.query(`
            SELECT MAX(CAST(SUBSTRING_INDEX(job_no, '-', -1) AS UNSIGNED)) as max_number
            FROM job_cards 
            WHERE job_no LIKE ?
        `, [searchPattern]);

        let nextNumber = startNumber;
        if (maxJobResult[0]?.max_number) {
            const maxNum = Number(maxJobResult[0].max_number);
            if (!isNaN(maxNum)) {
                nextNumber = Math.max(maxNum + 1, startNumber);
            }
        }

        const formattedNumber = nextNumber.toString().padStart(6, '0');
        
        let jobNumber;
        if (prefix === 'SJ') {
            jobNumber = `${prefix}-${year}-${formattedNumber}`;
        } else {
            jobNumber = `${prefix}${typeSuffix}${year}-${formattedNumber}`;
        }

        console.log('Preview job number:', jobNumber);

        res.json({
            success: true,
            nextJobNumber: jobNumber,
            previewOnly: true
        });

    } catch (error) {
        console.error('Error fetching next job number:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate job number: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});



// Get job cards for dashboard board view
app.get('/api/dashboard/board-data', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();

        // Get job cards grouped by status
        const boardData = {
            transit: [], // draft status
            arrived: [], // submitted status
            completed: [] // completed status
        };

        // Draft/Transit job cards
        const transitJobs = await conn.query(`
            SELECT 
                jc.*,
                COALESCE(i.total, 0) as invoice_total,
                i.status as invoice_status
            FROM job_cards jc
            LEFT JOIN invoices i ON jc.id = i.job_card_id
            WHERE jc.status IN ('draft', 'submitted', 'approved')
            ORDER BY jc.created_at DESC
            LIMIT 50
        `);

        // Arrived job cards (you can define what 'arrived' means in your business logic)
        const arrivedJobs = await conn.query(`
            SELECT 
                jc.*,
                COALESCE(i.total, 0) as invoice_total,
                i.status as invoice_status
            FROM job_cards jc
            LEFT JOIN invoices i ON jc.id = i.job_card_id
            WHERE jc.status = 'approved'
            ORDER BY jc.eta ASC
            LIMIT 50
        `);

        // Completed job cards
        const completedJobs = await conn.query(`
            SELECT 
                jc.*,
                COALESCE(i.total, 0) as invoice_total,
                i.status as invoice_status
            FROM job_cards jc
            LEFT JOIN invoices i ON jc.id = i.job_card_id
            WHERE jc.status = 'completed'
            ORDER BY jc.completed_at DESC
            LIMIT 50
        `);

        boardData.transit = transitJobs;
        boardData.arrived = arrivedJobs;
        boardData.completed = completedJobs;

        res.json({
            success: true,
            data: boardData,
            counts: {
                transit: transitJobs.length,
                arrived: arrivedJobs.length,
                completed: completedJobs.length
            }
        });

    } catch (error) {
        console.error('Get board data error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load board data: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});



// ==================== CUSTOMER ROUTES - CORRECT ORDER ====================

// ✅ 1. Get customer status with job card stats (SPECIFIC - MUST BE FIRST)
app.get('/api/customers/status', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();

        // Fetch all customers
        const customers = await conn.query("SELECT * FROM customers ORDER BY name ASC");

        // Fetch job card stats
        const jobStats = await conn.query(`
            SELECT 
                customer_name, 
                status, 
                job_no,
                departure_location,
                arrival_location
            FROM job_cards 
            WHERE customer_name IS NOT NULL AND customer_name != ''
        `);

        const customerData = customers.map(cust => {
            // Find jobs for this customer
            const custJobs = jobStats.filter(j =>
                j.customer_name &&
                j.customer_name.toLowerCase() === cust.name.toLowerCase()
            );

            let ongoing = 0;
            let completed = 0;
            let remainingJobs = [];

            custJobs.forEach(job => {
                const status = (job.status || '').toLowerCase();
                if (status === 'completed' || status === 'delivered') {
                    completed++;
                } else if (status === 'cancelled' || status === 'rejected') {
                    // Do nothing
                } else {
                    ongoing++;
                    remainingJobs.push({
                        id: job.job_no || 'Unknown',
                        status: job.status || 'Pending',
                        route: `${job.departure_location || ''} → ${job.arrival_location || ''}`.trim() || 'N/A'
                    });
                }
            });

            return {
                id: cust.id,
                name: cust.name,
                phone: cust.phone || '',
                email: cust.email || '',
                ref: cust.reference_number || '',
                company: cust.company || '',
                ongoing,
                completed,
                remainingJobs
            };
        });

        res.json({
            success: true,
            data: customerData
        });

    } catch (error) {
        console.error('Error fetching customers status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch customers status'
        });
    } finally {
        if (conn) await conn.end();
    }
});

// ✅ 2. Search customers (SPECIFIC - MUST BE SECOND)
app.get('/api/customers/search', async (req, res) => {
    let conn;
    try {
        const { q } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        conn = await getDbConnection();

        const customers = await conn.query(`
            SELECT id, name, company, email, phone, address, reference_number
            FROM customers 
            WHERE name LIKE ? OR company LIKE ? OR email LIKE ?
            ORDER BY name
            LIMIT 15
        `, [`%${q}%`, `%${q}%`, `%${q}%`]);

        res.json(customers);

    } catch (error) {
        console.error('Search customers error:', error);
        res.status(500).json([]);
    } finally {
        if (conn) await conn.end();
    }
});

// ✅ 3. GET all customers (GENERIC - AFTER SPECIFIC ROUTES)
app.get('/api/customers', async (req, res) => {
    let conn;
    try {
        const { search = '', limit = 100 } = req.query;

        conn = await getDbConnection();

        let query = `
            SELECT 
                id, 
                name, 
                company, 
                email, 
                phone, 
                address, 
                reference_number,
                created_at,
                updated_at
            FROM customers 
            WHERE 1=1
        `;

        const params = [];

        if (search && search.length > 0) {
            query += ` AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)`;
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, searchPattern);
        }

        query += ` ORDER BY name ASC LIMIT ?`;
        params.push(parseInt(limit));

        const customers = await conn.query(query, params);

        res.json({
            success: true,
            data: customers
        });

    } catch (error) {
        console.error('Get customers error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get customers: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// ✅ 4. GET single customer by ID (GENERIC - MUST BE AFTER /api/customers/status and /api/customers/search)
app.get('/api/customers/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid customer ID format'
            });
        }

        conn = await getDbConnection();

        const customer = await conn.query(
            `SELECT id, name, company, email, phone, address, reference_number 
             FROM customers WHERE id = ?`,
            [id]
        );

        if (customer.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Customer not found'
            });
        }

        res.json({
            success: true,
            data: customer[0]
        });

    } catch (error) {
        console.error('Get customer error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get customer: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// ✅ 5. CREATE new customer
app.post('/api/customers', async (req, res) => {
    let conn;
    try {
        const { name, company, email, phone, address, reference_number } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Customer name is required'
            });
        }

        conn = await getDbConnection();

        // Check if customer already exists
        const existing = await conn.query(
            'SELECT id FROM customers WHERE LOWER(name) = LOWER(?)',
            [name.trim()]
        );

        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Customer already exists with this name'
            });
        }

        const customerId = uuidv4();

        await conn.query(`
            INSERT INTO customers (
id, name, company, email, phone, address, reference_number,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            customerId,
            name.trim(),
            company || '',
            email || '',
            phone || '',
            address || '',
            reference_number || '',
            new Date(),
            new Date()
        ]);

        res.json({
            success: true,
            message: 'Customer created successfully',
            id: customerId,
            data: {
                id: customerId,
                name: name.trim(),
                company: company || '',
                email: email || '',
                phone: phone || '',
                address: address || '',
                reference_number: reference_number || ''
            }
        });

    } catch (error) {
        console.error('Create customer error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create customer: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// ✅ 6. UPDATE customer
app.put('/api/customers/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { name, company, email, phone, address, reference_number } = req.body;

        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid customer ID format'
            });
        }

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Customer name is required'
            });
        }

        conn = await getDbConnection();

        // Check if customer exists
        const existing = await conn.query('SELECT id FROM customers WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Customer not found'
            });
        }

        // Check if another customer has the same name (excluding this one)
        const duplicateCheck = await conn.query(
            'SELECT id FROM customers WHERE LOWER(name) = LOWER(?) AND id != ?',
            [name.trim(), id]
        );
        if (duplicateCheck.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Another customer already exists with this name'
            });
        }

        await conn.query(`
            UPDATE customers 
            SET name = ?, company = ?, email = ?, phone = ?, address = ?, 
                reference_number = ?, updated_at = ?
            WHERE id = ?
        `, [
            name.trim(),
            company || '',
            email || '',
            phone || '',
            address || '',
            reference_number || '',
            new Date(),
            id
        ]);

        res.json({
            success: true,
            message: 'Customer updated successfully'
        });

    } catch (error) {
        console.error('Update customer error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update customer: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// ✅ 7. DELETE customer
app.delete('/api/customers/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid customer ID format'
            });
        }

        conn = await getDbConnection();

        // Check if customer exists
        const existing = await conn.query('SELECT id, name FROM customers WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Customer not found'
            });
        }

        // Check if customer has job cards
        const jobCards = await conn.query(
            'SELECT COUNT(*) as count FROM job_cards WHERE customer_id = ?',
            [id]
        );

        if (jobCards[0]?.count > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete customer with ${jobCards[0].count} associated job cards. Archive or reassign first.`
            });
        }

        // Check if customer has invoices
        const invoices = await conn.query(
            'SELECT COUNT(*) as count FROM invoices WHERE customer_id = ?',
            [id]
        );

        if (invoices[0]?.count > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete customer with ${invoices[0].count} associated invoices. Archive or reassign first.`
            });
        }

        await conn.query('DELETE FROM customers WHERE id = ?', [id]);

        res.json({
            success: true,
            message: 'Customer deleted successfully'
        });

    } catch (error) {
        console.error('Delete customer error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete customer: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});


// Search requesters
app.get('/api/requesters/search', async (req, res) => {
    let conn;
    try {
        const { q } = req.query;

        if (!q || q.length < 2) return res.json([]);

        conn = await getDbConnection();

        const requesters = await conn.query(`
            SELECT DISTINCT requester_name as name
            FROM job_cards
            WHERE requester_name LIKE ?
            ORDER BY requester_name
            LIMIT 10
        `, [`%${q}%`]);

        res.json(requesters);

    } catch (error) {
        console.error('Search requesters error:', error);
        res.status(500).json([]);
    } finally {
        if (conn) await conn.end();
    }
});





// Save job card - Updated with foreign keys
app.post('/api/jobcards/save-draft', async (req, res) => {
    let conn;
    try {
        const jobData = req.body;

        // Map frontend payload names to what backend expects
        jobData.customer = jobData.customer || jobData.customerName;
        jobData.consignee = jobData.consignee || jobData.consigneeName;
        jobData.shipper = jobData.shipper || jobData.shipperName;
        jobData.agent = jobData.agent || jobData.agentName;

        const userId = req.user?.userId || 'system';

        console.log('📝 Saving job card draft:', jobData.jobNo || 'New');

        // Generate job number if not provided
        let jobNumber = jobData.jobNo;
        if (!jobNumber) {
            jobNumber = await generateJobCardNumber(
                jobData.transportMode || jobData.modeOfTravel || 'ROA',
                jobData.shipmentType || 'I'
            );
        }

        conn = await getDbConnection();
        await conn.beginTransaction();

        const jobCardId = uuidv4();
        let invoiceNumber = await generateInvoiceNumber();

        // Ensure invoice number is unique
        let attempts = 0;
        while (!await validateInvoiceNumber(invoiceNumber) && attempts < 10) {
            const parts = invoiceNumber.split('/');
            let num = parseInt(parts[2]);
            if (!isNaN(num)) {
                num++;
                invoiceNumber = `INV/${parts[1]}/${num.toString().padStart(5, '0')}`;
            } else {
                invoiceNumber = await generateInvoiceNumber();
            }
            attempts++;
        }

        if (attempts > 0) {
            console.log(`Generated invoice number after ${attempts} attempts: ${invoiceNumber}`);
        }

        // Helper function to get ID from lookup table
        async function getLookupId(tableName, code) {
            if (!code) return null;
            try {
                const result = await conn.query(
                    `SELECT id FROM ${tableName} WHERE code = ? OR name = ?`,
                    [code, code]
                );
                return result.length > 0 ? result[0].id : null;
            } catch (error) {
                console.log(`Error getting ID from ${tableName}:`, error.message);
                return null;
            }
        }

        // Get lookup IDs
        const cargoTypeId = await getLookupId('cargo_types', jobData.cargoType);
        const serviceModeId = await getLookupId('service_modes', jobData.serviceMode);
        const incotermId = await getLookupId('incoterms', jobData.incoterms);
        const ccRegimeId = await getLookupId('cc_regimes', jobData.ccRegime);
        const transportModeId = await getLookupId('transport_modes', jobData.transportMode || jobData.modeOfTravel);
        const shipmentTypeId = await getLookupId('shipment_types', jobData.shipmentType);
        const responsiblePersonId = await getLookupId('responsible_persons', jobData.responsiblePerson);

        // Get customer/consignee/shipper/agent IDs
        let customerId = null;
        const customerVal = jobData.customer || jobData.customerName;
        if (customerVal) {
            const customer = await conn.query(
                'SELECT id FROM customers WHERE name = ? OR id = ?',
                [customerVal, customerVal]
            );
            if (customer.length > 0) {
                customerId = customer[0].id;
            } else {
                // Create new customer if not exists
                const newCustomerId = uuidv4();
                await conn.query(`
                    INSERT INTO customers (
id, name, email, phone, address, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    newCustomerId,
                    customerVal,
                    jobData.contactEmail || '',
                    jobData.contactDetails || '',
                    jobData.deliveryLocation || '',
                    new Date(),
                    new Date()
                ]);
                customerId = newCustomerId;
                console.log(`✅ Created new customer: ${customerVal}`);
            }
        }

        let consigneeId = null;
        if (jobData.consignee) {
            const consignee = await conn.query(
                'SELECT id FROM consignees WHERE name = ? OR id = ?',
                [jobData.consignee, jobData.consignee]
            );
            if (consignee.length > 0) {
                consigneeId = consignee[0].id;
            } else {
                const newConsigneeId = uuidv4();
                await conn.query(`
                    INSERT INTO consignees (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
                `, [newConsigneeId, jobData.consignee, new Date(), new Date()]);
                consigneeId = newConsigneeId;
                console.log(`✅ Created new consignee: ${jobData.consignee}`);
            }
        }

        let shipperId = null;
        const shipperVal = jobData.shipper || jobData.shipperName;
        if (shipperVal) {
            const shipper = await conn.query(
                'SELECT id FROM shippers WHERE name = ? OR id = ?',
                [shipperVal, shipperVal]
            );
            if (shipper.length > 0) {
                shipperId = shipper[0].id;
            } else {
                const newShipperId = uuidv4();
                await conn.query(`
                    INSERT INTO shippers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
                `, [newShipperId, shipperVal, new Date(), new Date()]);
                shipperId = newShipperId;
                console.log(`✅ Created new shipper: ${shipperVal}`);
            }
        }

        // Resolve agent: prefer explicit UUID sent from frontend, fall back to name lookup
        jobData.agent = jobData.agentName || jobData.agent || '';

        let agentId = null;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        // 1. If frontend sent an explicit agentId UUID, resolve by ID first (no name-ambiguity)
        if (jobData.agentId && uuidRegex.test(jobData.agentId)) {
            const existing = await conn.query('SELECT id FROM agents WHERE id = ?', [jobData.agentId]);
            if (existing.length > 0) {
                agentId = jobData.agentId;
                console.log(`✅ Agent resolved by ID: ${agentId}`);
            }
        }

        // 2. Fall back to name-based lookup / create
        if (!agentId && jobData.agent) {
            const agent = await conn.query(
                'SELECT id FROM agents WHERE name = ? OR id = ?',
                [jobData.agent, jobData.agent]
            );

            if (agent.length > 0) {
                agentId = agent[0].id;
            } else {
                // Create new agent if not exists
                const newAgentId = uuidv4();
                await conn.query(`
                    INSERT INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
                `, [newAgentId, jobData.agent, new Date(), new Date()]);
                agentId = newAgentId;
                console.log(`✅ Created new agent: ${jobData.agent}`);
            }
        }
        // Get ministry approval IDs as JSON
        let ministryApprovalIds = null;
        if (jobData.ministryApprovals && Array.isArray(jobData.ministryApprovals)) {
            const approvalIds = [];
            for (const approval of jobData.ministryApprovals) {
                const result = await conn.query(
                    'SELECT id FROM ministry_approvals WHERE code = ? OR name = ?',
                    [approval, approval]
                );
                if (result.length > 0) {
                    approvalIds.push(result[0].id);
                }
            }
            ministryApprovalIds = approvalIds.length > 0 ? JSON.stringify(approvalIds) : null;
        }

        // Insert job card
        await conn.query(`
            INSERT INTO job_cards (
id, job_no, operation_date,
                cargo_type_id, service_mode_id, incoterm_id, cc_regime_id,
                transport_mode_id, shipment_type_id, responsible_person_id,
                mawb, hawb, cost_center, cost_center_number, shipping_line,
                no_of_packages, packages_unit, gross_weight, gross_weight_unit,
                nett_weight, nett_weight_unit, chargeable_weight, chargeable_weight_unit,
                volume, shipper_ref_no,
                customer_id, consignee_id, shipper_id, agent_id,
                pol, pod, atd, ata, transit_time,
                driver_name, vehicle_number, delivery_location, customs_location,
                contact_person, contact_details, contact_email,
                declaration_number, declaration_date, bayan_no, bayan_date, clearance_date, delivery_date,
                cc_number, requestor_name, po_number, delivery_status,
                commercial_invoice_no, master_remarks, delivery_remarks,
                attested_docs_received, deposit_category, deposit_amount, deposit_currency,
                deposit_applied_date, customs_deposit_release_no, deposit_refund_last_date,
                clearance_remarks, ministry_approval_ids,
                bank_guarantee_number, issuance_bank, bg_amount,
                ti_bayan_expiry_date, ti_file_status, ti_part_number,
                partial_re_export, partial_re_export_pn, ti_remarks,
                te_part_number, te_bayan_expiry_date, te_file_status, te_remarks,
                transporter_id, transporter_name,  -- ← ADD THESE
                status, created_by, user_id, created_at, invoice_no
            )  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            jobCardId,
            jobNumber,
            jobData.operationDate || jobData.date || new Date().toISOString().split('T')[0],
            cargoTypeId,
            serviceModeId,
            incotermId,
            ccRegimeId,
            transportModeId,
            shipmentTypeId,
            responsiblePersonId,
            jobData.mawb || null,
            jobData.hawb || null,
            jobData.costCenter || null,
            jobData.costCenterNumber || null,
            jobData.shippingLine || null,
            parseInt(jobData.noOfPackages) || 0,
            jobData.packagesUnit || 'pcs',
            parseFloat(jobData.grossWeight) || 0,
            jobData.grossWeightUnit || 'kg',
            parseFloat(jobData.nettWeight) || 0,
            jobData.nettWeightUnit || 'kg',
            parseFloat(jobData.chargeableWeight) || 0,
            jobData.chargeableWeightUnit || 'kg',
            jobData.volume || null,
            jobData.shipperRef || null,
            customerId,
            consigneeId,
            shipperId,
            agentId,
            jobData.pol || null,
            jobData.pod || null,
            jobData.atd || null,
            jobData.ata || null,
            jobData.transitTime || null,
            jobData.driverName || null,
            jobData.vehicleNumber || null,
            jobData.deliveryLocation || null,
            jobData.customsLocation || null,
            jobData.contactPerson || null,
            jobData.contactDetails || null,
            jobData.contactEmail || null,
            jobData.declarationNumber || null,
            jobData.declarationDate || null,
            jobData.bayanNumber || null,
            jobData.bayanDate || null,
            jobData.clearanceDate || null,
            jobData.deliveryDate || null,
            jobData.ccNumber || null,
            jobData.requestorName || null,
            jobData.poNumber || null,
            jobData.deliveryStatus || null,
            jobData.commercialInvoiceNo || null,
            jobData.masterRemarks || null,
            jobData.deliveryNote || null,
            jobData.attestedDocs || null,
            jobData.depositCategory || null,
            parseFloat(jobData.depositAmount) || 0,
            jobData.depositCurrency || 'KD',
            jobData.depositAppliedDate || null,
            jobData.customsDepositReleaseNo || null,
            jobData.depositRefundLastDate || null,
            jobData.clearanceRemarks || null,
            ministryApprovalIds,
            jobData.bankGuaranteeNumber || null,
            jobData.issuanceBank || null,
            parseFloat(jobData.bgAmount) || 0,
            jobData.tiBayanExpiryDate || null,
            jobData.tiFileStatus || 'OPEN',
            jobData.tiPartNumber || null,
            jobData.partialReExport || 'NO',
            jobData.partialReExportPn || null,
            jobData.tiRemarks || null,
            jobData.tePartNumber || null,
            jobData.teBayanExpiryDate || null,
            jobData.teFileStatus || 'OPEN',
            jobData.teRemarks || null,
            jobData.transporterId || null,  // ← ADD transporter_id
            jobData.transporter || null,    // ← ADD transporter_name
            'draft',
            userId,
            userId,
            new Date(),
            invoiceNumber
        ]);

        console.log(`✅ Job card inserted: ${jobNumber}`);

        // Create invoice record
        const invoiceId = uuidv4();
        await conn.query(`
            INSERT INTO invoices (
id, invoice_no, job_card_id, customer_id,
                date, due_date, subtotal, tax, total,
                status, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            invoiceId,
            invoiceNumber,
            jobCardId,
            customerId,
            new Date().toISOString().split('T')[0],
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            0, 0, 0,
            'draft',
            userId,
            new Date()
        ]);

        

        console.log(`✅ Invoice created: ${invoiceNumber}`);

        await conn.commit();

        // Log audit
        await logAudit(userId, 'JOB_CARD_DRAFT_SAVED',
            `Draft saved: ${jobNumber} with invoice: ${invoiceNumber}`, req);

        res.json({
            success: true,
            message: 'Job Card draft saved successfully',
            id: jobCardId,
            jobNumber: jobNumber,
            invoiceNumber: invoiceNumber
        });

    } catch (error) {
        if (conn) {
            try {
                await conn.rollback();
                console.log('✅ Transaction rolled back due to error');
            } catch (rollbackError) {
                console.error('❌ Rollback failed:', rollbackError.message);
            }
        }

        console.error('❌ Save draft error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to save draft: ' + error.message,
            errorDetails: error.toString()
        });
    } finally {
        if (conn) {
            try {
                await conn.end();
            } catch (endError) {
                console.error('Error closing connection:', endError);
            }
        }
    }
});


// ==================== LOOKUP DATA ENDPOINTS ====================
// Get all lookup data in one call
app.get('/api/lookup/all', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();

        const [cargoTypes, serviceModes, incoterms, ccRegimes, ministryApprovals,
            responsiblePersons, transportModes, shipmentTypes] = await Promise.all([
                conn.query('SELECT id, code, name, description FROM cargo_types WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name FROM service_modes WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name FROM incoterms WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name FROM cc_regimes WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name FROM ministry_approvals WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name, email, phone, department FROM responsible_persons WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name FROM transport_modes WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name FROM shipment_types WHERE is_active = TRUE ORDER BY sort_order, name')
            ]);

        res.json({
            success: true,
            data: {
                cargoTypes,
                serviceModes,
                incoterms,
                ccRegimes,
                ministryApprovals,
                responsiblePersons,
                transportModes,
                shipmentTypes
            }
        });
    } catch (error) {
        console.error('Get all lookup data error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Get all cargo types
app.get('/api/lookup/cargo-types', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        const result = await conn.query(
            'SELECT id, code, name, description FROM cargo_types WHERE is_active = TRUE ORDER BY sort_order, name'
        );
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Get cargo types error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// Get all service modes
app.get('/api/lookup/service-modes', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        const result = await conn.query(
            'SELECT id, code, name FROM service_modes WHERE is_active = TRUE ORDER BY sort_order, name'
        );
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Get service modes error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// Get all incoterms
app.get('/api/lookup/incoterms', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        const result = await conn.query(
            'SELECT id, code, name FROM incoterms WHERE is_active = TRUE ORDER BY sort_order, name'
        );
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Get incoterms error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// Get all CC regimes
app.get('/api/lookup/cc-regimes', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        const result = await conn.query(
            'SELECT id, code, name FROM cc_regimes WHERE is_active = TRUE ORDER BY sort_order, name'
        );
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Get CC regimes error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// Get all ministry approvals
app.get('/api/lookup/ministry-approvals', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        const result = await conn.query(
            'SELECT id, code, name FROM ministry_approvals WHERE is_active = TRUE ORDER BY sort_order, name'
        );
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Get ministry approvals error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// Get all responsible persons
app.get('/api/lookup/responsible-persons', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        const result = await conn.query(
            'SELECT id, code, name, email, phone, department FROM responsible_persons WHERE is_active = TRUE ORDER BY sort_order, name'
        );
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Get responsible persons error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// ==================== RESPONSIBLE PERSONS CRUD ====================

// GET all responsible persons (management list, includes inactive)
app.get('/api/responsible-persons', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        const rows = await conn.query(`
            SELECT id, code, name, email, phone, department, is_active, sort_order, created_at, updated_at
            FROM responsible_persons
            ORDER BY sort_order ASC, name ASC
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Get responsible persons error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// GET search responsible persons (for autocomplete)
app.get('/api/responsible-persons/search', async (req, res) => {
    let conn;
    try {
        const q = req.query.q || '';
        conn = await getDbConnection();
        const rows = await conn.query(`
            SELECT id, code, name, email, phone, department
            FROM responsible_persons
            WHERE is_active = TRUE
              AND (name LIKE ? OR code LIKE ? OR department LIKE ?)
            ORDER BY sort_order ASC, name ASC
            LIMIT 20
        `, [`%${q}%`, `%${q}%`, `%${q}%`]);
        res.json(rows);
    } catch (error) {
        console.error('Search responsible persons error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// GET single responsible person
app.get('/api/responsible-persons/:id', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        const rows = await conn.query(
            'SELECT * FROM responsible_persons WHERE id = ?',
            [req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
        res.json({ success: true, data: rows[0] });
    } catch (error) {
        console.error('Get responsible person error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// POST create responsible person
app.post('/api/responsible-persons', async (req, res) => {
    let conn;
    try {
        const { name, code, email, phone, department, sort_order } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Name is required' });
        }

        // Auto-generate code if not provided
        const finalCode = (code && code.trim())
            ? code.trim().toUpperCase()
            : 'RP_' + Date.now();

        conn = await getDbConnection();

        // Check duplicate code
        const existing = await conn.query(
            'SELECT id FROM responsible_persons WHERE code = ?',
            [finalCode]
        );
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: `Code "${finalCode}" already exists` });
        }

        const id = uuidv4();
        await conn.query(`
            INSERT INTO responsible_persons (id, code, name, email, phone, department, is_active, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, TRUE, ?, NOW(), NOW())
        `, [
            id,
            finalCode,
            name.trim(),
            email || '',
            phone || '',
            department || '',
            parseInt(sort_order) || 0
        ]);

        const created = await conn.query('SELECT * FROM responsible_persons WHERE id = ?', [id]);
        res.json({ success: true, message: 'Responsible person created successfully', data: created[0] });
    } catch (error) {
        console.error('Create responsible person error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// PUT update responsible person
app.put('/api/responsible-persons/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { name, code, email, phone, department, is_active, sort_order } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Name is required' });
        }

        conn = await getDbConnection();

        // Check exists
        const existing = await conn.query('SELECT id FROM responsible_persons WHERE id = ?', [id]);
        if (existing.length === 0) return res.status(404).json({ success: false, message: 'Not found' });

        // Check code conflict with another record
        if (code) {
            const codeConflict = await conn.query(
                'SELECT id FROM responsible_persons WHERE code = ? AND id != ?',
                [code.trim().toUpperCase(), id]
            );
            if (codeConflict.length > 0) {
                return res.status(400).json({ success: false, message: `Code "${code}" already in use` });
            }
        }

        await conn.query(`
            UPDATE responsible_persons
            SET name = ?, code = COALESCE(NULLIF(?, ''), code),
                email = ?, phone = ?, department = ?,
                is_active = ?, sort_order = ?,
                updated_at = NOW()
            WHERE id = ?
        `, [
            name.trim(),
            code ? code.trim().toUpperCase() : '',
            email || '',
            phone || '',
            department || '',
            is_active !== undefined ? (is_active ? 1 : 0) : 1,
            parseInt(sort_order) || 0,
            id
        ]);

        const updated = await conn.query('SELECT * FROM responsible_persons WHERE id = ?', [id]);
        res.json({ success: true, message: 'Updated successfully', data: updated[0] });
    } catch (error) {
        console.error('Update responsible person error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// DELETE responsible person
app.delete('/api/responsible-persons/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        conn = await getDbConnection();

        const existing = await conn.query('SELECT id, name FROM responsible_persons WHERE id = ?', [id]);
        if (existing.length === 0) return res.status(404).json({ success: false, message: 'Not found' });

        // Soft delete — set is_active = FALSE to preserve job card history
        await conn.query(
            'UPDATE responsible_persons SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
            [id]
        );

        res.json({ success: true, message: `"${existing[0].name}" deactivated successfully` });
    } catch (error) {
        console.error('Delete responsible person error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});
app.get('/api/lookup/transport-modes', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        const result = await conn.query(
            'SELECT id, code, name FROM transport_modes WHERE is_active = TRUE ORDER BY sort_order, name'
        );
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Get transport modes error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// Get all shipment types
app.get('/api/lookup/shipment-types', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        const result = await conn.query(
            'SELECT id, code, name FROM shipment_types WHERE is_active = TRUE ORDER BY sort_order, name'
        );
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Get shipment types error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// Get all lookup data in one call
app.get('/api/lookup/all', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();

        const [cargoTypes, serviceModes, incoterms, ccRegimes, ministryApprovals,
            responsiblePersons, transportModes, shipmentTypes] = await Promise.all([
                conn.query('SELECT id, code, name, description FROM cargo_types WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name FROM service_modes WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name FROM incoterms WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name FROM cc_regimes WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name FROM ministry_approvals WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name, email, phone, department FROM responsible_persons WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name FROM transport_modes WHERE is_active = TRUE ORDER BY sort_order, name'),
                conn.query('SELECT id, code, name FROM shipment_types WHERE is_active = TRUE ORDER BY sort_order, name')
            ]);

        res.json({
            success: true,
            data: {
                cargoTypes,
                serviceModes,
                incoterms,
                ccRegimes,
                ministryApprovals,
                responsiblePersons,
                transportModes,
                shipmentTypes
            }
        });
    } catch (error) {
        console.error('Get all lookup data error:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});



// Submit job card - COMBINED & CORRECTED VERSION
// GET /api/jobcards/:id/history
app.get('/api/jobcards/:id/history', async (req, res) => {
    try {
        const conn = await getDbConnection();
        const history = await conn.query(
            `SELECT * FROM job_cards_history WHERE job_card_id = ? ORDER BY version_timestamp DESC`,
            [req.params.id]
        );
        res.json({ success: true, data: history });
    } catch (error) {
        console.error('Error fetching job card history:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET /api/jobcards/history/single/:historyId
app.get('/api/jobcards/history/single/:historyId', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        const history = await conn.query(
            `SELECT * FROM job_cards_history WHERE history_id = ?`,
            [req.params.historyId]
        );
        if (history && history.length > 0) {
            res.json({ success: true, data: history[0] });
        } else {
            res.status(404).json({ success: false, message: 'History record not found' });
        }
    } catch (error) {
        console.error('Error fetching job card history single:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// POST /api/jobcards/:id/restore/:historyId
app.post('/api/jobcards/:id/restore/:historyId', async (req, res) => {
    let conn;
    try {
        const jobId = req.params.id;
        const historyId = req.params.historyId;

        conn = await getDbConnection();
        await conn.beginTransaction();

        // 1. Snapshot the *current* state before restoring
        await conn.query(`
            INSERT INTO job_cards_history (
                job_card_id, action, job_no, transporter_id, transporter_name,
                operation_date, cargo_type_id, service_mode_id,
                incoterm_id, cc_regime_id, transport_mode_id, shipment_type_id, responsible_person_id,
                mawb, hawb, cost_center, cost_center_number, shipping_line, no_of_packages,
                packages_unit, gross_weight, gross_weight_unit, nett_weight, nett_weight_unit,
                chargeable_weight, chargeable_weight_unit, volume, shipper_ref_no, customer_id,
                consignee_id, shipper_id, agent_id, pol, pod, atd, ata, transit_time,
                driver_name, vehicle_number, delivery_location, customs_location, contact_person,
                contact_details, contact_email, declaration_number, declaration_date, bayan_no,
                bayan_date, clearance_date, delivery_date, cc_number, requestor_name, po_number,
                delivery_status, commercial_invoice_no, master_remarks, delivery_remarks,
                attested_docs_received, deposit_category, deposit_amount, deposit_currency,
                deposit_applied_date, customs_deposit_release_no, deposit_refund_last_date,
                clearance_remarks, ministry_approval_ids, bank_guarantee_number, issuance_bank,
                bg_amount, ti_bayan_expiry_date, ti_file_status, ti_part_number, partial_re_export,
                partial_re_export_pn, ti_remarks, te_part_number, te_bayan_expiry_date,
                te_file_status, te_remarks, status, created_by, user_id, created_at, invoice_no
            )
            SELECT 
                id, 'RESTORE', job_no, operation_date, cargo_type_id, service_mode_id,
                incoterm_id, cc_regime_id, transport_mode_id, shipment_type_id, responsible_person_id,
                mawb, hawb, cost_center, cost_center_number, shipping_line, no_of_packages,
                packages_unit, gross_weight, gross_weight_unit, nett_weight, nett_weight_unit,
                chargeable_weight, chargeable_weight_unit, volume, shipper_ref_no, customer_id,
                consignee_id, shipper_id, agent_id, pol, pod, atd, ata, transit_time,
                driver_name, vehicle_number, delivery_location, customs_location, contact_person,
                contact_details, contact_email, declaration_number, declaration_date, bayan_no,
                bayan_date, clearance_date, delivery_date, cc_number, requestor_name, po_number,
                delivery_status, commercial_invoice_no, master_remarks, delivery_remarks,
                attested_docs_received, deposit_category, deposit_amount, deposit_currency,
                deposit_applied_date, customs_deposit_release_no, deposit_refund_last_date,
                clearance_remarks, ministry_approval_ids, bank_guarantee_number, issuance_bank,
                bg_amount, ti_bayan_expiry_date, ti_file_status, ti_part_number, partial_re_export,
                partial_re_export_pn, ti_remarks, te_part_number, te_bayan_expiry_date,
                te_file_status, te_remarks, status, created_by, user_id, created_at, invoice_no
            FROM job_cards 
            WHERE id = ?
        `, [jobId]);

        // 2. Fetch the historical data to restore
        const historicalData = await conn.query(`SELECT * FROM job_cards_history WHERE history_id = ? AND job_card_id = ?`, [historyId, jobId]);
        if (!historicalData || historicalData.length === 0) {
            throw new Error('Historical data not found or mismatch with job card ID');
        }

        // 3. Update the job_cards table using an UPDATE with a JOIN approach to avoid huge UPDATE statement, 
        // wait, MariaDB supports UPDATE with JOIN.
        await conn.query(`
            UPDATE job_cards jc
            INNER JOIN job_cards_history jch ON jc.id = jch.job_card_id
            SET 
                jc.job_no = jch.job_no,
                jc.operation_date = jch.operation_date,
                jc.transporter_id = jch.transporter_id,
                jc.transporter_name = jch.transporter_name,
                jc.cargo_type_id = jch.cargo_type_id,
                jc.service_mode_id = jch.service_mode_id,
                jc.incoterm_id = jch.incoterm_id,
                jc.cc_regime_id = jch.cc_regime_id,
                jc.transport_mode_id = jch.transport_mode_id,
                jc.shipment_type_id = jch.shipment_type_id,
                jc.responsible_person_id = jch.responsible_person_id,
                jc.mawb = jch.mawb,
                jc.hawb = jch.hawb,
                jc.cost_center = jch.cost_center,
                jc.cost_center_number = jch.cost_center_number,
                jc.shipping_line = jch.shipping_line,
                jc.no_of_packages = jch.no_of_packages,
                jc.packages_unit = jch.packages_unit,
                jc.gross_weight = jch.gross_weight,
                jc.gross_weight_unit = jch.gross_weight_unit,
                jc.nett_weight = jch.nett_weight,
                jc.nett_weight_unit = jch.nett_weight_unit,
                jc.chargeable_weight = jch.chargeable_weight,
                jc.chargeable_weight_unit = jch.chargeable_weight_unit,
                jc.volume = jch.volume,
                jc.shipper_ref_no = jch.shipper_ref_no,
                jc.customer_id = jch.customer_id,
                jc.consignee_id = jch.consignee_id,
                jc.shipper_id = jch.shipper_id,
                jc.agent_id = jch.agent_id,
                jc.pol = jch.pol,
                jc.pod = jch.pod,
                jc.atd = jch.atd,
                jc.ata = jch.ata,
                jc.transit_time = jch.transit_time,
                jc.driver_name = jch.driver_name,
                jc.vehicle_number = jch.vehicle_number,
                jc.delivery_location = jch.delivery_location,
                jc.customs_location = jch.customs_location,
                jc.contact_person = jch.contact_person,
                jc.contact_details = jch.contact_details,
                jc.contact_email = jch.contact_email,
                jc.declaration_number = jch.declaration_number,
                jc.declaration_date = jch.declaration_date,
                jc.bayan_no = jch.bayan_no,
                jc.bayan_date = jch.bayan_date,
                jc.clearance_date = jch.clearance_date,
                jc.delivery_date = jch.delivery_date,
                jc.cc_number = jch.cc_number,
                jc.requestor_name = jch.requestor_name,
                jc.po_number = jch.po_number,
                jc.delivery_status = jch.delivery_status,
                jc.commercial_invoice_no = jch.commercial_invoice_no,
                jc.master_remarks = jch.master_remarks,
                jc.delivery_remarks = jch.delivery_remarks,
                jc.attested_docs_received = jch.attested_docs_received,
                jc.deposit_category = jch.deposit_category,
                jc.deposit_amount = jch.deposit_amount,
                jc.deposit_currency = jch.deposit_currency,
                jc.deposit_applied_date = jch.deposit_applied_date,
                jc.customs_deposit_release_no = jch.customs_deposit_release_no,
                jc.deposit_refund_last_date = jch.deposit_refund_last_date,
                jc.clearance_remarks = jch.clearance_remarks,
                jc.ministry_approval_ids = jch.ministry_approval_ids,
                jc.bank_guarantee_number = jch.bank_guarantee_number,
                jc.issuance_bank = jch.issuance_bank,
                jc.bg_amount = jch.bg_amount,
                jc.ti_bayan_expiry_date = jch.ti_bayan_expiry_date,
                jc.ti_file_status = jch.ti_file_status,
                jc.ti_part_number = jch.ti_part_number,
                jc.partial_re_export = jch.partial_re_export,
                jc.partial_re_export_pn = jch.partial_re_export_pn,
                jc.ti_remarks = jch.ti_remarks,
                jc.te_part_number = jch.te_part_number,
                jc.te_bayan_expiry_date = jch.te_bayan_expiry_date,
                jc.te_file_status = jch.te_file_status,
                jc.te_remarks = jch.te_remarks,
                jc.status = jch.status,
                jc.invoice_no = jch.invoice_no
            WHERE jch.history_id = ? AND jc.id = ?
        `, [historyId, jobId]);

        await conn.commit();
        res.json({ success: true, message: 'Restored successfully' });
    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Error restoring job card:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// PUT /api/jobcards/:id/edit
app.put('/api/jobcards/:id/edit', async (req, res) => {
    let conn;
    try {
        const jobId = req.params.id;
        const jobData = req.body;

        // Map frontend payload names to what backend expects
        jobData.customer = jobData.customer || jobData.customerName;
        jobData.consignee = jobData.consignee || jobData.consigneeName;
        jobData.shipper = jobData.shipper || jobData.shipperName;
        jobData.agent = jobData.agent || jobData.agentName;

        console.log(`📝 Editing job card ID: ${jobId}`);
        console.log('Received jobData:', jobData);

        conn = await getDbConnection();
        await conn.beginTransaction();

        // 1. Fetch current job card state
        const currentJob = await conn.query('SELECT * FROM job_cards WHERE id = ?', [jobId]);
        if (!currentJob || currentJob.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, message: 'Job card not found' });
        }

        // Helper function to get ID from lookup table
        async function getLookupId(tableName, code) {
            if (!code) return null;
            try {
                const result = await conn.query(
                    `SELECT id FROM ${tableName} WHERE code = ? OR name = ?`,
                    [code, code]
                );
                return result.length > 0 ? result[0].id : null;
            } catch (err) {
                console.error(`Error looking up ${code} in ${tableName}:`, err);
                return null;
            }
        }

        // Get lookup IDs
        const cargoTypeId = await getLookupId('cargo_types', jobData.cargoType);
        const serviceModeId = await getLookupId('service_modes', jobData.serviceMode);
        const incotermId = await getLookupId('incoterms', jobData.incoterms);
        const ccRegimeId = await getLookupId('cc_regimes', jobData.ccRegime);
        const transportModeId = await getLookupId('transport_modes', jobData.transportMode || jobData.modeOfTravel);
        const shipmentTypeId = await getLookupId('shipment_types', jobData.shipmentType);
        const responsiblePersonId = await getLookupId('responsible_persons', jobData.responsiblePerson);

        // Get customer/consignee/shipper/agent IDs
        let customerId = null;
        const customerVal = jobData.customer || jobData.customerName;
        if (customerVal) {
            const customer = await conn.query(
                'SELECT id FROM customers WHERE name = ? OR id = ?',
                [customerVal, customerVal]
            );
            if (customer.length > 0) {
                customerId = customer[0].id;
            } else {
                const newCustomerId = uuidv4();
                await conn.query(`
                    INSERT INTO customers (id, name, email, phone, address, created_at, updated_at) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [newCustomerId, customerVal, jobData.contactEmail || '', jobData.contactDetails || '', jobData.deliveryLocation || '', new Date(), new Date()]);
                customerId = newCustomerId;
                console.log(`✅ Created new customer: ${customerVal}`);
            }
        }

        let consigneeId = null;
        if (jobData.consignee) {
            const consignee = await conn.query(
                'SELECT id FROM consignees WHERE name = ? OR id = ?',
                [jobData.consignee, jobData.consignee]
            );
            if (consignee.length > 0) {
                consigneeId = consignee[0].id;
            } else {
                const newConsigneeId = uuidv4();
                await conn.query(`
                    INSERT INTO consignees (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
                `, [newConsigneeId, jobData.consignee, new Date(), new Date()]);
                consigneeId = newConsigneeId;
                console.log(`✅ Created new consignee: ${jobData.consignee}`);
            }
        }

        let shipperId = null;
        const shipperVal = jobData.shipper || jobData.shipperName;
        if (shipperVal) {
            const shipper = await conn.query(
                'SELECT id FROM shippers WHERE name = ? OR id = ?',
                [shipperVal, shipperVal]
            );
            if (shipper.length > 0) {
                shipperId = shipper[0].id;
            } else {
                const newShipperId = uuidv4();
                await conn.query(`
                    INSERT INTO shippers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
                `, [newShipperId, shipperVal, new Date(), new Date()]);
                shipperId = newShipperId;
                console.log(`✅ Created new shipper: ${shipperVal}`);
            }
        }

        // Resolve agent
        jobData.agent = jobData.agentName || jobData.agent || '';
        let agentId = null;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        // Try using agentId first if provided and valid
        if (jobData.agentId && uuidRegex.test(jobData.agentId)) {
            const existing = await conn.query('SELECT id FROM agents WHERE id = ?', [jobData.agentId]);
            if (existing.length > 0) {
                agentId = jobData.agentId;
                console.log(`✅ Agent resolved by ID: ${agentId}`);
            }
        }

        // If not resolved by ID, try by name
        if (!agentId && jobData.agent) {
            const agent = await conn.query(
                'SELECT id FROM agents WHERE name = ? OR id = ?',
                [jobData.agent, jobData.agent]
            );
            if (agent.length > 0) {
                agentId = agent[0].id;
            } else if (jobData.agent && jobData.agent.trim() !== '') {
                const newAgentId = uuidv4();
                await conn.query(`
                    INSERT INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
                `, [newAgentId, jobData.agent, new Date(), new Date()]);
                agentId = newAgentId;
                console.log(`✅ Created new agent: ${jobData.agent}`);
            }
        }

        // Get ministry approval IDs as JSON
        let ministryApprovalIds = null;
        if (jobData.ministryApprovals && Array.isArray(jobData.ministryApprovals)) {
            const approvalIds = [];
            for (const approval of jobData.ministryApprovals) {
                const result = await conn.query(
                    'SELECT id FROM ministry_approvals WHERE code = ? OR name = ?',
                    [approval, approval]
                );
                if (result.length > 0) {
                    approvalIds.push(result[0].id);
                }
            }
            ministryApprovalIds = approvalIds.length > 0 ? JSON.stringify(approvalIds) : null;
        }

        // Format dates - handle operationDate
        let operationDate = jobData.operationDate || jobData.date || null;
        if (operationDate && typeof operationDate === 'string' && operationDate.includes('T')) {
            operationDate = operationDate.split('T')[0];
        }

        // Format ATD (datetime-local to MySQL datetime)
        let atdDateTime = null;
        if (jobData.atd) {
            if (typeof jobData.atd === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(jobData.atd)) {
                atdDateTime = jobData.atd.replace('T', ' ') + ':00';
            } else if (typeof jobData.atd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(jobData.atd)) {
                atdDateTime = jobData.atd + ' 00:00:00';
            } else {
                try {
                    const date = new Date(jobData.atd);
                    if (!isNaN(date.getTime())) {
                        const year = date.getFullYear();
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const day = String(date.getDate()).padStart(2, '0');
                        const hours = String(date.getHours()).padStart(2, '0');
                        const minutes = String(date.getMinutes()).padStart(2, '0');
                        atdDateTime = `${year}-${month}-${day} ${hours}:${minutes}:00`;
                    }
                } catch (e) {
                    console.error('Error parsing ATD:', e);
                }
            }
        }

        // 2. Insert current state into history table BEFORE updating
        await conn.query(`
            INSERT INTO job_cards_history (
                job_card_id, action, job_no, operation_date,
                cargo_type_id, service_mode_id, incoterm_id, cc_regime_id,
                transport_mode_id, shipment_type_id, responsible_person_id,
                mawb, hawb, cost_center, cost_center_number, shipping_line,
                no_of_packages, packages_unit, gross_weight, gross_weight_unit,
                nett_weight, nett_weight_unit, chargeable_weight, chargeable_weight_unit,
                volume, shipper_ref_no,
                customer_id, consignee_id, shipper_id, agent_id,
                pol, pod, atd, ata, transit_time,
                driver_name, vehicle_number, delivery_location, customs_location,
                contact_person, contact_details, contact_email,
                declaration_number, declaration_date, bayan_no, bayan_date, clearance_date, delivery_date,
                cc_number, requestor_name, po_number, delivery_status,
                commercial_invoice_no, master_remarks, delivery_remarks,
                attested_docs_received, deposit_category, deposit_amount, deposit_currency,
                deposit_applied_date, customs_deposit_release_no, deposit_refund_last_date,
                clearance_remarks, ministry_approval_ids,
                bank_guarantee_number, issuance_bank, bg_amount,
                ti_bayan_expiry_date, ti_file_status, ti_part_number,
                partial_re_export, partial_re_export_pn, ti_remarks,
                te_part_number, te_bayan_expiry_date, te_file_status, te_remarks,
                transporter_id, transporter_name,
                status, created_by, user_id, created_at, invoice_no
            ) SELECT 
                id, 'UPDATE', job_no, operation_date,
                cargo_type_id, service_mode_id, incoterm_id, cc_regime_id,
                transport_mode_id, shipment_type_id, responsible_person_id,
                mawb, hawb, cost_center, cost_center_number, shipping_line,
                no_of_packages, packages_unit, gross_weight, gross_weight_unit,
                nett_weight, nett_weight_unit, chargeable_weight, chargeable_weight_unit,
                volume, shipper_ref_no,
                customer_id, consignee_id, shipper_id, agent_id,
                pol, pod, atd, ata, transit_time,
                driver_name, vehicle_number, delivery_location, customs_location,
                contact_person, contact_details, contact_email,
                declaration_number, declaration_date, bayan_no, bayan_date, clearance_date, delivery_date,
                cc_number, requestor_name, po_number, delivery_status,
                commercial_invoice_no, master_remarks, delivery_remarks,
                attested_docs_received, deposit_category, deposit_amount, deposit_currency,
                deposit_applied_date, customs_deposit_release_no, deposit_refund_last_date,
                clearance_remarks, ministry_approval_ids,
                bank_guarantee_number, issuance_bank, bg_amount,
                ti_bayan_expiry_date, ti_file_status, ti_part_number,
                partial_re_export, partial_re_export_pn, ti_remarks,
                te_part_number, te_bayan_expiry_date, te_file_status, te_remarks,
                transporter_id, transporter_name,
                status, created_by, user_id, created_at, invoice_no
            FROM job_cards WHERE id = ?
        `, [jobId]);

        // 3. Update the job card
        await conn.query(`
            UPDATE job_cards SET
                operation_date = ?,
                cargo_type_id = ?, service_mode_id = ?, incoterm_id = ?, cc_regime_id = ?,
                transport_mode_id = ?, shipment_type_id = ?, responsible_person_id = ?,
                mawb = ?, hawb = ?, cost_center = ?, cost_center_number = ?, shipping_line = ?,
                no_of_packages = ?, packages_unit = ?, gross_weight = ?, gross_weight_unit = ?,
                nett_weight = ?, nett_weight_unit = ?, chargeable_weight = ?, chargeable_weight_unit = ?,
                volume = ?, shipper_ref_no = ?,
                customer_id = ?, consignee_id = ?, shipper_id = ?, agent_id = ?,
                pol = ?, pod = ?, atd = ?, ata = ?, transit_time = ?,
                driver_name = ?, vehicle_number = ?, delivery_location = ?, customs_location = ?,
                contact_person = ?, contact_details = ?, contact_email = ?,
                declaration_number = ?, declaration_date = ?, bayan_no = ?, bayan_date = ?, 
                clearance_date = ?, delivery_date = ?,
                cc_number = ?, requestor_name = ?, po_number = ?, delivery_status = ?,
                commercial_invoice_no = ?, master_remarks = ?, delivery_remarks = ?,
                attested_docs_received = ?, deposit_category = ?, deposit_amount = ?, deposit_currency = ?,
                deposit_applied_date = ?, customs_deposit_release_no = ?, deposit_refund_last_date = ?,
                clearance_remarks = ?, ministry_approval_ids = ?,
                bank_guarantee_number = ?, issuance_bank = ?, bg_amount = ?,
                ti_bayan_expiry_date = ?, ti_file_status = ?, ti_part_number = ?,
                partial_re_export = ?, partial_re_export_pn = ?, ti_remarks = ?,
                transporter_id = ?, transporter_name = ?,
                te_part_number = ?, te_bayan_expiry_date = ?, te_file_status = ?, te_remarks = ?,
                updated_at = NOW()
            WHERE id = ?
        `, [
            operationDate,
            cargoTypeId, serviceModeId, incotermId, ccRegimeId,
            transportModeId, shipmentTypeId, responsiblePersonId,
            jobData.mawb || null, jobData.hawb || null, jobData.costCenter || null, jobData.costCenterNumber || null, jobData.shippingLine || null,
            parseInt(jobData.noOfPackages) || 0, jobData.packagesUnit || 'pcs', parseFloat(jobData.grossWeight) || 0, jobData.grossWeightUnit || 'kg',
            parseFloat(jobData.nettWeight) || 0, jobData.nettWeightUnit || 'kg', parseFloat(jobData.chargeableWeight) || 0, jobData.chargeableWeightUnit || 'kg',
            jobData.volume || null, jobData.shipperRef || null,
            customerId, consigneeId, shipperId, agentId,
            jobData.pol || null, jobData.pod || null, atdDateTime, jobData.ata || null, jobData.transitTime || null,
            jobData.driverName || null, jobData.vehicleNumber || null, jobData.deliveryLocation || null, jobData.customsLocation || null,
            jobData.contactPerson || null, jobData.contactDetails || null, jobData.contactEmail || null,
            jobData.declarationNumber || null, jobData.declarationDate || null, jobData.bayanNumber || null, jobData.bayanDate || null,
            jobData.clearanceDate || null, jobData.deliveryDate || null,
            jobData.ccNumber || null, jobData.requestorName || null, jobData.poNumber || null, jobData.deliveryStatus || null,
            jobData.commercialInvoiceNo || null, jobData.masterRemarks || null, jobData.deliveryNote || null,
            jobData.attestedDocs || null, jobData.depositCategory || null, parseFloat(jobData.depositAmount) || 0, jobData.depositCurrency || 'KD',
            jobData.depositAppliedDate || null, jobData.customsDepositReleaseNo || null, jobData.depositRefundLastDate || null,
            jobData.clearanceRemarks || null, ministryApprovalIds,
            jobData.bankGuaranteeNumber || null, jobData.issuanceBank || null, parseFloat(jobData.bgAmount) || 0,
            jobData.tiBayanExpiryDate || null, jobData.tiFileStatus || 'OPEN', jobData.tiPartNumber || null,
            jobData.partialReExport || 'NO', jobData.partialReExportPn || null, jobData.tiRemarks || null,
            jobData.transporterId || null, jobData.transporter || null,
            jobData.tePartNumber || null, jobData.teBayanExpiryDate || null, jobData.teFileStatus || 'OPEN', jobData.teRemarks || null,
            jobId
        ]);

        await conn.commit();
        res.json({ success: true, message: 'Job card updated successfully' });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Error updating job card:', error);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// Get all shipping lines for dropdown
app.get('/api/shipping-lines/all', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        
        const results = await conn.query(`
            SELECT id, name, code, type, country
            FROM shipping_lines 
            WHERE is_active = TRUE
            ORDER BY name ASC
        `);
        
        res.json({
            success: true,
            data: results
        });
        
    } catch (error) {
        console.error('Get shipping lines all error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get shipping lines: ' + error.message,
            data: []
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Get all ports for dropdown
app.get('/api/ports/all', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        
        const results = await conn.query(`
            SELECT id, name, code, country, city, type
            FROM ports 
            WHERE is_active = TRUE
            ORDER BY name ASC
        `);
        
        res.json({
            success: true,
            data: results
        });
        
    } catch (error) {
        console.error('Get ports all error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get ports: ' + error.message,
            data: []
        });
    } finally {
        if (conn) await conn.end();
    }
});


// Get all shipping lines/airlines
app.get('/api/shipping-lines', async (req, res) => {
    let conn;
    try {
        const { search = '', limit = 100 } = req.query;
        
        conn = await getDbConnection();
        
        let query = `
            SELECT id, name, code, type, country, is_active, created_at, updated_at
            FROM shipping_lines 
            WHERE 1=1
        `;
        
        const params = [];
        
        if (search && search.length > 0) {
            query += ` AND (name LIKE ? OR code LIKE ? OR country LIKE ?)`;
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, searchPattern);
        }
        
        query += ` ORDER BY name ASC LIMIT ?`;
        params.push(parseInt(limit));
        
        const results = await conn.query(query, params);
        
        res.json({
            success: true,
            data: results
        });
        
    } catch (error) {
        console.error('Get shipping lines error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get shipping lines: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Search shipping lines for autocomplete
app.get('/api/shipping-lines/search', async (req, res) => {
    let conn;
    try {
        const { q } = req.query;
        
        if (!q || q.length < 2) {
            return res.json([]);
        }
        
        conn = await getDbConnection();
        
        const results = await conn.query(`
            SELECT id, name, code, type, country
            FROM shipping_lines 
            WHERE (name LIKE ? OR code LIKE ? OR country LIKE ?)
            AND is_active = TRUE
            ORDER BY name
            LIMIT 15
        `, [`%${q}%`, `%${q}%`, `%${q}%`]);
        
        res.json(results);
        
    } catch (error) {
        console.error('Search shipping lines error:', error);
        res.status(500).json([]);
    } finally {
        if (conn) await conn.end();
    }
});

// Get single shipping line by ID
app.get('/api/shipping-lines/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        
        conn = await getDbConnection();
        
        const result = await conn.query(
            `SELECT id, name, code, type, country, is_active, created_at, updated_at
             FROM shipping_lines WHERE id = ?`,
            [id]
        );
        
        if (result.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Shipping line not found'
            });
        }
        
        res.json({
            success: true,
            data: result[0]
        });
        
    } catch (error) {
        console.error('Get shipping line error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get shipping line: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Create new shipping line/airline
app.post('/api/shipping-lines', async (req, res) => {
    let conn;
    try {
        const { name, code, type, country } = req.body;
        
        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Name is required'
            });
        }
        
        conn = await getDbConnection();
        
        // Check if already exists
        const existing = await conn.query(
            'SELECT id FROM shipping_lines WHERE LOWER(name) = LOWER(?)',
            [name.trim()]
        );
        
        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Shipping line already exists with this name'
            });
        }
        
        const id = uuidv4();
        const shippingType = type || 'shipping'; // 'shipping' or 'airline'
        
        await conn.query(`
            INSERT INTO shipping_lines (id, name, code, type, country, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, TRUE, NOW(), NOW())
        `, [id, name.trim(), code || null, shippingType, country || null]);
        
        const newRecord = await conn.query(
            'SELECT id, name, code, type, country FROM shipping_lines WHERE id = ?',
            [id]
        );
        
        res.json({
            success: true,
            message: 'Shipping line created successfully',
            data: newRecord[0]
        });
        
    } catch (error) {
        console.error('Create shipping line error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create shipping line: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Update shipping line
app.put('/api/shipping-lines/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { name, code, type, country, is_active } = req.body;
        
        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Name is required'
            });
        }
        
        conn = await getDbConnection();
        
        const existing = await conn.query('SELECT id FROM shipping_lines WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Shipping line not found'
            });
        }
        
        await conn.query(`
            UPDATE shipping_lines 
            SET name = ?, code = ?, type = ?, country = ?, is_active = ?, updated_at = NOW()
            WHERE id = ?
        `, [name.trim(), code || null, type || 'shipping', country || null, is_active !== undefined ? is_active : 1, id]);
        
        res.json({
            success: true,
            message: 'Shipping line updated successfully'
        });
        
    } catch (error) {
        console.error('Update shipping line error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update shipping line: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Delete shipping line
app.delete('/api/shipping-lines/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        
        conn = await getDbConnection();
        
        const existing = await conn.query('SELECT id FROM shipping_lines WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Shipping line not found'
            });
        }
        
        // Check if used in job cards
        const used = await conn.query(
            'SELECT COUNT(*) as count FROM job_cards WHERE shipping_line_id = ?',
            [id]
        );
        
        if (used[0]?.count > 0) {
            // Soft delete - just deactivate
            await conn.query(
                'UPDATE shipping_lines SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
                [id]
            );
            return res.json({
                success: true,
                message: 'Shipping line deactivated as it is in use'
            });
        }
        
        await conn.query('DELETE FROM shipping_lines WHERE id = ?', [id]);
        
        res.json({
            success: true,
            message: 'Shipping line deleted successfully'
        });
        
    } catch (error) {
        console.error('Delete shipping line error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete shipping line: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// ==================== PORTS ENDPOINTS ====================

// Get all ports
app.get('/api/ports', async (req, res) => {
    let conn;
    try {
        const { search = '', limit = 100 } = req.query;
        
        conn = await getDbConnection();
        
        let query = `
            SELECT id, name, code, country, city, type, is_active, created_at, updated_at
            FROM ports 
            WHERE 1=1
        `;
        
        const params = [];
        
        if (search && search.length > 0) {
            query += ` AND (name LIKE ? OR code LIKE ? OR country LIKE ? OR city LIKE ?)`;
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }
        
        query += ` ORDER BY name ASC LIMIT ?`;
        params.push(parseInt(limit));
        
        const results = await conn.query(query, params);
        
        res.json({
            success: true,
            data: results
        });
        
    } catch (error) {
        console.error('Get ports error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get ports: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Search ports for autocomplete
app.get('/api/ports/search', async (req, res) => {
    let conn;
    try {
        const { q } = req.query;
        
        if (!q || q.length < 2) {
            return res.json([]);
        }
        
        conn = await getDbConnection();
        
        const results = await conn.query(`
            SELECT id, name, code, country, city, type
            FROM ports 
            WHERE (name LIKE ? OR code LIKE ? OR country LIKE ? OR city LIKE ?)
            AND is_active = TRUE
            ORDER BY name
            LIMIT 15
        `, [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]);
        
        res.json(results);
        
    } catch (error) {
        console.error('Search ports error:', error);
        res.status(500).json([]);
    } finally {
        if (conn) await conn.end();
    }
});

// Get single port by ID
app.get('/api/ports/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        
        conn = await getDbConnection();
        
        const result = await conn.query(
            `SELECT id, name, code, country, city, type, is_active, created_at, updated_at
             FROM ports WHERE id = ?`,
            [id]
        );
        
        if (result.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Port not found'
            });
        }
        
        res.json({
            success: true,
            data: result[0]
        });
        
    } catch (error) {
        console.error('Get port error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get port: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Create new port
app.post('/api/ports', async (req, res) => {
    let conn;
    try {
        const { name, code, country, city, type } = req.body;
        
        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Name is required'
            });
        }
        
        conn = await getDbConnection();
        
        // Check if already exists
        const existing = await conn.query(
            'SELECT id FROM ports WHERE LOWER(name) = LOWER(?)',
            [name.trim()]
        );
        
        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Port already exists with this name'
            });
        }
        
        const id = uuidv4();
        const portType = type || 'seaport'; // 'seaport', 'airport', 'inland'
        
        await conn.query(`
            INSERT INTO ports (id, name, code, country, city, type, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, TRUE, NOW(), NOW())
        `, [id, name.trim(), code || null, country || null, city || null, portType]);
        
        const newRecord = await conn.query(
            'SELECT id, name, code, country, city, type FROM ports WHERE id = ?',
            [id]
        );
        
        res.json({
            success: true,
            message: 'Port created successfully',
            data: newRecord[0]
        });
        
    } catch (error) {
        console.error('Create port error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create port: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Update port
app.put('/api/ports/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { name, code, country, city, type, is_active } = req.body;
        
        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Name is required'
            });
        }
        
        conn = await getDbConnection();
        
        const existing = await conn.query('SELECT id FROM ports WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Port not found'
            });
        }
        
        await conn.query(`
            UPDATE ports 
            SET name = ?, code = ?, country = ?, city = ?, type = ?, is_active = ?, updated_at = NOW()
            WHERE id = ?
        `, [name.trim(), code || null, country || null, city || null, type || 'seaport', is_active !== undefined ? is_active : 1, id]);
        
        res.json({
            success: true,
            message: 'Port updated successfully'
        });
        
    } catch (error) {
        console.error('Update port error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update port: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Delete port
app.delete('/api/ports/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        
        conn = await getDbConnection();
        
        const existing = await conn.query('SELECT id FROM ports WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Port not found'
            });
        }
        
        // Check if used in job cards
        const used = await conn.query(
            'SELECT COUNT(*) as count FROM job_cards WHERE pol_id = ? OR pod_id = ?',
            [id, id]
        );
        
        if (used[0]?.count > 0) {
            // Soft delete - just deactivate
            await conn.query(
                'UPDATE ports SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
                [id]
            );
            return res.json({
                success: true,
                message: 'Port deactivated as it is in use'
            });
        }
        
        await conn.query('DELETE FROM ports WHERE id = ?', [id]);
        
        res.json({
            success: true,
            message: 'Port deleted successfully'
        });
        
    } catch (error) {
        console.error('Delete port error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete port: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});



app.post('/api/jobcards/submit', async (req, res) => {
    let conn;
    try {
        const jobData = req.body;

        // Map frontend payload names to what backend expects
        jobData.customer = jobData.customer || jobData.customerName;
        jobData.consignee = jobData.consignee || jobData.consigneeName;
        jobData.shipper = jobData.shipper || jobData.shipperName;
        jobData.agent = jobData.agent || jobData.agentName;

        const userId = req.user?.userId || 'system';

        console.log('📝 Submitting job card:', jobData.jobNo || 'New');

        // Generate job number if not provided
        let jobNumber = jobData.jobNo;
        if (!jobNumber) {
            jobNumber = await generateJobCardNumber(
                jobData.transportMode || jobData.modeOfTravel || 'ROA',
                jobData.shipmentType || 'I'
            );
        }

        conn = await getDbConnection();
        await conn.beginTransaction();

        const jobCardId = uuidv4();
        let invoiceNumber = await generateInvoiceNumber();

        // Ensure invoice number is unique
        let attempts = 0;
        while (!await validateInvoiceNumber(invoiceNumber) && attempts < 10) {
            const parts = invoiceNumber.split('/');
            let num = parseInt(parts[2]);
            if (!isNaN(num)) {
                num++;
                invoiceNumber = `INV/${parts[1]}/${num.toString().padStart(5, '0')}`;
            } else {
                invoiceNumber = await generateInvoiceNumber();
            }
            attempts++;
        }

        if (attempts > 0) {
            console.log(`Generated invoice number after ${attempts} attempts: ${invoiceNumber}`);
        }

        // Helper function to get ID from lookup table
        async function getLookupId(tableName, code) {
            if (!code) return null;
            try {
                const result = await conn.query(
                    `SELECT id FROM ${tableName} WHERE code = ? OR name = ?`,
                    [code, code]
                );
                return result.length > 0 ? result[0].id : null;
            } catch (error) {
                console.log(`Error getting ID from ${tableName}:`, error.message);
                return null;
            }
        }

        // Get lookup IDs
        const cargoTypeId = await getLookupId('cargo_types', jobData.cargoType);
        const serviceModeId = await getLookupId('service_modes', jobData.serviceMode);
        const incotermId = await getLookupId('incoterms', jobData.incoterms);
        const ccRegimeId = await getLookupId('cc_regimes', jobData.ccRegime);
        const transportModeId = await getLookupId('transport_modes', jobData.transportMode || jobData.modeOfTravel);
        const shipmentTypeId = await getLookupId('shipment_types', jobData.shipmentType);
        const responsiblePersonId = await getLookupId('responsible_persons', jobData.responsiblePerson);

        // Get customer/consignee/shipper/agent IDs
        let customerId = null;
        const customerVal = jobData.customer || jobData.customerName;
        if (customerVal) {
            const customer = await conn.query(
                'SELECT id FROM customers WHERE name = ? OR id = ?',
                [customerVal, customerVal]
            );
            if (customer.length > 0) {
                customerId = customer[0].id;
            } else {
                // Create new customer if not exists
                const newCustomerId = uuidv4();
                await conn.query(`
                    INSERT INTO customers (
id, name, email, phone, address, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    newCustomerId,
                    customerVal,
                    jobData.contactEmail || '',
                    jobData.contactDetails || '',
                    jobData.deliveryLocation || '',
                    new Date(),
                    new Date()
                ]);
                customerId = newCustomerId;
                console.log(`✅ Created new customer: ${customerVal}`);
            }
        }

        let consigneeId = null;
        if (jobData.consignee) {
            const consignee = await conn.query(
                'SELECT id FROM consignees WHERE name = ? OR id = ?',
                [jobData.consignee, jobData.consignee]
            );
            if (consignee.length > 0) {
                consigneeId = consignee[0].id;
            } else {
                const newConsigneeId = uuidv4();
                await conn.query(`
                    INSERT INTO consignees (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
                `, [newConsigneeId, jobData.consignee, new Date(), new Date()]);
                consigneeId = newConsigneeId;
                console.log(`✅ Created new consignee: ${jobData.consignee}`);
            }
        }

        let shipperId = null;
        const shipperVal = jobData.shipper || jobData.shipperName;
        if (shipperVal) {
            const shipper = await conn.query(
                'SELECT id FROM shippers WHERE name = ? OR id = ?',
                [shipperVal, shipperVal]
            );
            if (shipper.length > 0) {
                shipperId = shipper[0].id;
            } else {
                const newShipperId = uuidv4();
                await conn.query(`
                    INSERT INTO shippers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
                `, [newShipperId, shipperVal, new Date(), new Date()]);
                shipperId = newShipperId;
                console.log(`✅ Created new shipper: ${shipperVal}`);
            }
        }
        // Resolve agent: prefer explicit UUID sent from frontend, fall back to name lookup
        jobData.agent = jobData.agentName || jobData.agent || '';

        let agentId = null;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        // 1. If frontend sent an explicit agentId UUID, resolve by ID first (no name-ambiguity)
        if (jobData.agentId && uuidRegex.test(jobData.agentId)) {
            const existing = await conn.query('SELECT id FROM agents WHERE id = ?', [jobData.agentId]);
            if (existing.length > 0) {
                agentId = jobData.agentId;
                console.log(`✅ Agent resolved by ID: ${agentId}`);
            }
        }

        // 2. Fall back to name-based lookup / create
        if (!agentId && jobData.agent) {
            const agent = await conn.query(
                'SELECT id FROM agents WHERE name = ? OR id = ?',
                [jobData.agent, jobData.agent]
            );

            if (agent.length > 0) {
                agentId = agent[0].id;
            } else {
                // Create new agent if not exists
                const newAgentId = uuidv4();
                await conn.query(`
                    INSERT INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
                `, [newAgentId, jobData.agent, new Date(), new Date()]);
                agentId = newAgentId;
                console.log(`✅ Created new agent: ${jobData.agent}`);
            }
        }

        // Get ministry approval IDs as JSON
        let ministryApprovalIds = null;
        if (jobData.ministryApprovals && Array.isArray(jobData.ministryApprovals)) {
            const approvalIds = [];
            for (const approval of jobData.ministryApprovals) {
                const result = await conn.query(
                    'SELECT id FROM ministry_approvals WHERE code = ? OR name = ?',
                    [approval, approval]
                );
                if (result.length > 0) {
                    approvalIds.push(result[0].id);
                }
            }
            ministryApprovalIds = approvalIds.length > 0 ? JSON.stringify(approvalIds) : null;
        }

       // Should be like this:
        await conn.query(`
            INSERT INTO job_cards (
                id, job_no, operation_date,
                cargo_type_id, service_mode_id, incoterm_id, cc_regime_id,
                transport_mode_id, shipment_type_id, responsible_person_id,
                mawb, hawb, cost_center, cost_center_number, shipping_line,
                no_of_packages, packages_unit, gross_weight, gross_weight_unit,
                nett_weight, nett_weight_unit, chargeable_weight, chargeable_weight_unit,
                volume, shipper_ref_no,
                customer_id, consignee_id, shipper_id, agent_id,
                pol, pod, atd, ata, transit_time,
                driver_name, vehicle_number, delivery_location, customs_location,
                contact_person, contact_details, contact_email,
                declaration_number, declaration_date, bayan_no, bayan_date, clearance_date, delivery_date,
                cc_number, requestor_name, po_number, delivery_status,
                commercial_invoice_no, master_remarks, delivery_remarks,
                attested_docs_received, deposit_category, deposit_amount, deposit_currency,
                deposit_applied_date, customs_deposit_release_no, deposit_refund_last_date,
                clearance_remarks, ministry_approval_ids,
                bank_guarantee_number, issuance_bank, bg_amount,
                ti_bayan_expiry_date, ti_file_status, ti_part_number,
                partial_re_export, partial_re_export_pn, ti_remarks,
                te_part_number, te_bayan_expiry_date, te_file_status, te_remarks,
                transporter_id, transporter_name,  // ← Position 72
                status, created_by, user_id, created_at, invoice_no
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            jobCardId,
            jobNumber,
            jobData.operationDate || jobData.date || new Date().toISOString().split('T')[0],
            cargoTypeId,
            serviceModeId,
            incotermId,
            ccRegimeId,
            transportModeId,
            jobData.transporterId || null,
            jobData.transporter || null,
            shipmentTypeId,
            responsiblePersonId,
            jobData.mawb || null,
            jobData.hawb || null,
            jobData.costCenter || null,
            jobData.costCenterNumber || null,
            jobData.shippingLine || null,
            parseInt(jobData.noOfPackages) || 0,
            jobData.packagesUnit || 'pcs',
            parseFloat(jobData.grossWeight) || 0,
            jobData.grossWeightUnit || 'kg',
            parseFloat(jobData.nettWeight) || 0,
            jobData.nettWeightUnit || 'kg',
            parseFloat(jobData.chargeableWeight) || 0,
            jobData.chargeableWeightUnit || 'kg',
            jobData.volume || null,
            jobData.shipperRef || null,
            customerId,
            consigneeId,
            shipperId,
            agentId,
            jobData.pol || null,
            jobData.pod || null,
            jobData.atd || null,
            jobData.ata || null,
            jobData.transitTime || null,
            jobData.driverName || null,
            jobData.vehicleNumber || null,
            jobData.deliveryLocation || null,
            jobData.customsLocation || null,
            jobData.contactPerson || null,
            jobData.contactDetails || null,
            jobData.contactEmail || null,
            jobData.declarationNumber || null,
            jobData.declarationDate || null,
            jobData.bayanNumber || null,
            jobData.bayanDate || null,
            jobData.clearanceDate || null,
            jobData.deliveryDate || null,
            jobData.ccNumber || null,
            jobData.requestorName || null,
            jobData.poNumber || null,
            jobData.deliveryStatus || null,
            jobData.commercialInvoiceNo || null,
            jobData.masterRemarks || null,
            jobData.deliveryNote || null,
            jobData.attestedDocs || null,
            jobData.depositCategory || null,
            parseFloat(jobData.depositAmount) || 0,
            jobData.depositCurrency || 'KD',
            jobData.depositAppliedDate || null,
            jobData.customsDepositReleaseNo || null,
            jobData.depositRefundLastDate || null,
            jobData.clearanceRemarks || null,
            ministryApprovalIds,
            jobData.bankGuaranteeNumber || null,
            jobData.issuanceBank || null,
            parseFloat(jobData.bgAmount) || 0,
            jobData.tiBayanExpiryDate || null,
            jobData.tiFileStatus || 'OPEN',
            jobData.tiPartNumber || null,
            jobData.partialReExport || 'NO',
            jobData.partialReExportPn || null,
            jobData.tiRemarks || null,
            jobData.tePartNumber || null,
            jobData.teBayanExpiryDate || null,
            jobData.teFileStatus || 'OPEN',
            jobData.teRemarks || null,
            jobData.transporterId || null,  // ← Should match position 72
            jobData.transporter || null,    // ← Should match position 73
            'submitted',
            userId,
            userId,
            new Date(),
            invoiceNumber
        ]);

        console.log(`✅ Job card inserted: ${jobNumber}`);

        // Create invoice record
        const invoiceId = uuidv4();
        await conn.query(`
            INSERT INTO invoices (
id, invoice_no, job_card_id, customer_id,
                date, due_date, subtotal, tax, total,
                status, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            invoiceId,
            invoiceNumber,
            jobCardId,
            customerId,
            new Date().toISOString().split('T')[0],
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            0, 0, 0,
            'submitted',
            userId,
            new Date()
        ]);

        console.log(`✅ Invoice created: ${invoiceNumber}`);
        await conn.commit();

        // Log audit
        await logAudit(userId, 'JOB_CARD_SUBMITTED', `Submitted: ${jobData.jobNo} with invoice: ${invoiceNumber}`, req);

        res.json({
            success: true,
            message: 'Job Card submitted successfully',
            id: jobCardId,
            jobNumber: jobData.jobNo,
            invoiceNumber: invoiceNumber
        });

    } catch (error) {
        // ROLLBACK - Critical error handling
        if (conn) {
            try {
                await conn.rollback();
                console.error('✅ Transaction rolled back due to error:', error.message);
            } catch (rollbackError) {
                console.error('❌ Rollback failed:', rollbackError.message);
            }
        }

        console.error('Submit job card error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to submit job card: ' + error.message,
            errorDetails: error.toString()
        });
    } finally {
        // Always close connection
        if (conn) {
            try {
                await conn.end();
            } catch (endError) {
                console.error('Error closing connection:', endError);
            }
        }
    }
});
// Generate invoice from job card
app.post('/api/jobcards/generate-invoice', async (req, res) => {
    let conn;
    try {
        const { jobCardId, jobCardData } = req.body;

        conn = await getDbConnection();

        // Generate invoice number
        const year = new Date().getFullYear();
        const lastInvoice = await conn.query(
            "SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY id DESC LIMIT 1",
            [`INV/${year}/%`]
        );

        let invoiceNumber = `INV/${year}/08321`;
        if (lastInvoice.length > 0) {
            const lastNo = lastInvoice[0].invoice_no;
            const match = lastNo.match(/INV\/\d+\/(\d+)/);
            if (match) {
                const lastNum = parseInt(match[1]);
                invoiceNumber = `INV/${year}/${(lastNum + 1).toString().padStart(5, '0')}`;
            }
        }

        // Calculate invoice amounts
        const weight = parseFloat(jobCardData.grossWeight) || 0;
        const packages = parseInt(jobCardData.packages) || 0;

        // Sample calculation - adjust based on your business rules
        const freightCharge = weight * 5.5; // $5.5 per kg
        const handlingCharge = packages * 15; // $15 per package
        const customsCharge = weight * 2.5; // $2.5 per kg
        const totalAmount = freightCharge + handlingCharge + customsCharge;

        const invoiceData = {
            invoiceNumber: invoiceNumber,
            jobCardNumber: jobCardData.jobNo,
            customerName: jobCardData.customerName,
            customerRefNo: jobCardData.customerRefNo,
            date: new Date().toISOString().split('T')[0],
            dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            items: [
                {
                    description: "Freight Charges",
                    quantity: weight,
                    unit: "kg",
                    rate: 5.5,
                    amount: freightCharge
                },
                {
                    description: "Handling Charges",
                    quantity: packages,
                    unit: "package",
                    rate: 15,
                    amount: handlingCharge
                },
                {
                    description: "Customs Clearance",
                    quantity: weight,
                    unit: "kg",
                    rate: 2.5,
                    amount: customsCharge
                }
            ],
            subtotal: totalAmount,
            tax: totalAmount * 0.05, // 5% tax
            total: totalAmount + (totalAmount * 0.05),
            status: "draft"
        };

        res.json({
            success: true,
            invoice: invoiceData
        });

    } catch (error) {
        console.error('Generate invoice error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate invoice'
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Get job card stats - CORRECTED VERSION
app.get('/api/stats/jobcards', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();

        const jobCardStats = await conn.query(`
            SELECT 
                COUNT(*) as totalJobCards,
                SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted,
                SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as drafts
            FROM job_cards
        `);

        const invoiceStats = await conn.query(`
            SELECT COUNT(*) as totalInvoices FROM invoices
        `);

        // Convert BigInt to Number
        res.json({
            success: true,
            totalJobCards: Number(jobCardStats[0]?.totalJobCards) || 0,
            submittedJobCards: Number(jobCardStats[0]?.submitted) || 0,
            draftJobCards: Number(jobCardStats[0]?.drafts) || 0,
            totalInvoices: Number(invoiceStats[0]?.totalInvoices) || 0
        });

    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({
            success: false,
            totalJobCards: 0,
            totalInvoices: 0
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Get job card by number for invoice generation
app.get('/api/jobcards/:jobNumber/invoice', async (req, res) => {
    let conn;
    try {
        const { jobNumber } = req.params;

        conn = await getDbConnection();

        const jobCard = await conn.query(`
            SELECT * FROM job_cards WHERE job_no = ? AND status = 'submitted'
        `, [jobNumber]);

        if (jobCard.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Job card not found'
            });
        }

        // Generate invoice data
        const data = jobCard[0];
        const invoiceData = await generateInvoiceFromJobCard(data);

        res.json({
            success: true,
            jobCard: data,
            invoice: invoiceData
        });

    } catch (error) {
        console.error('Get job card error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get job card'
        });
    } finally {
        if (conn) await conn.end();
    }
});

async function generateInvoiceFromJobCard(jobCard) {
    // Generate invoice number
    const year = new Date().getFullYear();

    // Calculate invoice amounts
    const weight = parseFloat(jobCard.gross_weight) || 0;
    const packages = parseInt(jobCard.packages) || 0;

    const freightCharge = weight * 5.5;
    const handlingCharge = packages * 15;
    const customsCharge = weight * 2.5;
    const totalAmount = freightCharge + handlingCharge + customsCharge;

    return {
        invoiceNumber: `INV/${year}/08321`, // Will be incremented when saved
        jobCardNumber: jobCard.job_no,
        customerName: jobCard.customer_name,
        customerRefNo: jobCard.customer_ref_no,
        date: new Date().toISOString().split('T')[0],
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        items: [
            {
                description: "Freight Charges",
                quantity: weight,
                unit: "kg",
                rate: 5.5,
                amount: freightCharge
            },
            {
                description: "Handling Charges",
                quantity: packages,
                unit: "package",
                rate: 15,
                amount: handlingCharge
            },
            {
                description: "Customs Clearance",
                quantity: weight,
                unit: "kg",
                rate: 2.5,
                amount: customsCharge
            }
        ],
        subtotal: totalAmount,
        tax: totalAmount * 0.05,
        total: totalAmount + (totalAmount * 0.05),
        status: "draft"
    };
}



// ==================== INVOICE CHARGES WIZARD ENDPOINTS ====================

// Get full invoice details for a job card (for charges wizard)
app.get('/api/jobcards/:jobCardId/invoice-details', async (req, res) => {
    let conn;
    try {
        const { jobCardId } = req.params;

        conn = await getDbConnection();

        // First get the job card
        const jobCard = await conn.query(`
            SELECT 
                jc.id,
                jc.job_no,
                jc.departure_location,
                jc.arrival_location,
                jc.customer_name,
                jc.status,
                jc.invoice_no
            FROM job_cards jc
            WHERE jc.id = ? OR jc.job_no = ?
        `, [jobCardId, jobCardId]);

        if (jobCard.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Job card not found'
            });
        }

        const jobData = jobCard[0];

        // Check if invoice exists for this job card
        let invoice = await conn.query(`
            SELECT 
                i.id,
                i.invoice_no,
                i.subtotal,
                i.tax,
                i.total,
                i.status as invoice_status,
                i.date as invoice_date,
                i.due_date,
                i.notes,
                i.created_at
            FROM invoices i
            WHERE i.job_card_id = ?
        `, [jobData.id]);

        let invoiceId = null;
        let invoiceNumber = null;
        let charges = [];

        if (invoice.length > 0) {
            invoiceId = invoice[0].id;
            invoiceNumber = invoice[0].invoice_no;

            // Get existing charges for this invoice
            charges = await conn.query(`
                SELECT 
                    ii.id,
                    ii.description,
                    ii.quantity,
                    ii.unit,
                    ii.rate,
                    ii.amount,
                    ii.charge_type
                FROM invoice_items ii
                WHERE ii.invoice_id = ?
                ORDER BY ii.id
            `, [invoiceId]);

            console.log(`Found ${charges.length} existing charges for invoice ${invoiceNumber}`);
        }

        // Get advance payments if any
        const advancePayments = await conn.query(`
            SELECT 
                ap.id,
                ap.amount,
                ap.payment_date,
                ap.payment_method,
                ap.reference_number,
                ap.notes
            FROM advance_payments ap
            WHERE ap.invoice_id = ?
            ORDER BY ap.payment_date DESC
        `, [invoiceId]);

        const totalAdvance = advancePayments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

        res.json({
            success: true,
            data: {
                jobCard: {
                    id: jobData.id,
                    job_no: jobData.job_no,
                    departure_location: jobData.departure_location,
                    arrival_location: jobData.arrival_location,
                    customer_name: jobData.customer_name,
                    status: jobData.status
                },
                invoice: invoice.length > 0 ? {
                    id: invoiceId,
                    invoice_no: invoiceNumber,
                    subtotal: parseFloat(invoice[0].subtotal) || 0,
                    tax: parseFloat(invoice[0].tax) || 0,
                    total: parseFloat(invoice[0].total) || 0,
                    status: invoice[0].invoice_status,
                    date: invoice[0].invoice_date,
                    due_date: invoice[0].due_date,
                    notes: invoice[0].notes,
                    created_at: invoice[0].created_at
                } : null,
                charges: charges.map(c => ({
                    id: c.id,
                    description: c.description,
                    quantity: parseFloat(c.quantity),
                    unit: c.unit || 'each',
                    rate: parseFloat(c.rate),
                    amount: parseFloat(c.amount),
                    charge_type: c.charge_type || 'required'
                })),
                advance_payments: advancePayments,
                total_advance: totalAdvance,
                balance: (invoice.length > 0 ? parseFloat(invoice[0].total) : 0) - totalAdvance
            }
        });

    } catch (error) {
        console.error('Get invoice details error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get invoice details: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Save charges from wizard (add/update/delete)

// Save charges from wizard - FIXED to replace instead of add
app.post('/api/invoices/:invoiceId/save-charges', async (req, res) => {
    let conn;
    try {
        const { invoiceId } = req.params;
        const { charges, jobCardStatus } = req.body;
        const userId = req.user?.userId || 'system';

        if (!invoiceId) {
            return res.status(400).json({
                success: false,
                message: 'Invoice ID is required'
            });
        }

        conn = await getDbConnection();
        await conn.beginTransaction();

        // Get invoice details
        const invoice = await conn.query(
            'SELECT invoice_no, job_card_id FROM invoices WHERE id = ?',
            [invoiceId]
        );

        if (invoice.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found'
            });
        }

        // 🔥 CRITICAL FIX: Delete existing charges (replace, not add)
        const deleteResult = await conn.query('DELETE FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
        console.log(`Deleted ${deleteResult.affectedRows} existing charges for invoice ${invoice[0].invoice_no}`);

        // Calculate totals
        let subtotal = 0;

        // Insert new charges
        for (const charge of charges) {
            const amount = parseFloat(charge.amount) || 0;
            subtotal += amount;

            await conn.query(`
                INSERT INTO invoice_items (
invoice_id, description, quantity, unit,
                    rate, amount, charge_type, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                invoiceId,
                charge.description,
                parseFloat(charge.quantity) || 1,
                charge.unit || 'each',
                parseFloat(charge.rate) || 0,
                amount,
                charge.charge_type || 'required',
                new Date()
            ]);
        }

        console.log(`Inserted ${charges.length} new charges (replaced old ones)`);

        // Update invoice totals
        const total = subtotal;

        await conn.query(`
            UPDATE invoices 
            SET subtotal = ?, total = ?, updated_at = NOW()
            WHERE id = ?
        `, [subtotal, total, invoiceId]);

        // Update job card status if provided
        let jobStatusUpdated = false;
        if (jobCardStatus && invoice[0].job_card_id) {
            const validStatuses = ['draft', 'submitted', 'approved', 'completed'];
            if (validStatuses.includes(jobCardStatus)) {
                await conn.query(`
                    UPDATE job_cards 
                    SET status = ?,
                        ${jobCardStatus === 'submitted' ? 'submitted_at = NOW(), submitted_by = ?,' : ''}
                        ${jobCardStatus === 'approved' ? 'approved_at = NOW(), approved_by = ?,' : ''}
                        ${jobCardStatus === 'completed' ? 'completed_at = NOW(),' : ''}
                        updated_at = NOW()
                    WHERE id = ?
                `, [
                    jobCardStatus,
                    ...(jobCardStatus === 'submitted' ? [userId] : []),
                    ...(jobCardStatus === 'approved' ? [userId] : []),
                    invoice[0].job_card_id
                ]);
                jobStatusUpdated = true;
                console.log(`Job status updated to: ${jobCardStatus}`);
            }
        }

        await conn.commit();

        // Log audit
        await logAudit(userId, 'CHARGES_SAVED',
            `Saved ${charges.length} charges for invoice ${invoice[0].invoice_no} (replaced old ones)`, req);

        res.json({
            success: true,
            message: 'Charges saved successfully',
            invoiceId: invoiceId,
            invoiceNumber: invoice[0].invoice_no,
            totals: {
                subtotal: subtotal,
                total: total
            },
            chargesCount: charges.length,
            jobStatusUpdated: jobStatusUpdated
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Save charges error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save charges: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});


// Admin endpoint to fix invoice number gaps
app.post('/api/admin/fix-invoice-gaps', verifyAdmin, async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        await conn.beginTransaction();

        const year = new Date().getFullYear();

        console.log(`🔧 Fixing invoice number gaps for year ${year}...`);

        // Get all job cards with invoice numbers for this year, sorted by creation date
        const jobCards = await conn.query(`
            SELECT id, invoice_no, created_at
            FROM job_cards 
            WHERE invoice_no LIKE 'INV/${year}/%'
            ORDER BY created_at
        `);

        console.log(`Found ${jobCards.length} invoices to check`);

        let expectedNumber = 8231; // Your starting number
        let fixedCount = 0;

        for (const jobCard of jobCards) {
            const currentNumber = parseInt(jobCard.invoice_no.split('/')[2]);

            if (currentNumber !== expectedNumber) {
                // Create new invoice number
                const newInvoiceNumber = `INV/${year}/${expectedNumber.toString().padStart(5, '0')}`;

                // Check if new number already exists
                const check = await conn.query(
                    'SELECT id FROM job_cards WHERE invoice_no = ?',
                    [newInvoiceNumber]
                );

                if (check.length === 0) {
                    // Update job card
                    await conn.query(
                        'UPDATE job_cards SET invoice_no = ? WHERE id = ?',
                        [newInvoiceNumber, jobCard.id]
                    );

                    // Update invoices table if exists
                    await conn.query(
                        'UPDATE invoices SET invoice_no = ? WHERE invoice_no = ?',
                        [newInvoiceNumber, jobCard.invoice_no]
                    );

                    console.log(`Fixed: ${jobCard.invoice_no} → ${newInvoiceNumber}`);
                    fixedCount++;
                }
            }
            expectedNumber++;
        }

        // Update the invoice_numbers table with the new max
        const maxResult = await conn.query(`
            SELECT MAX(CAST(SUBSTRING_INDEX(invoice_no, '/', -1) AS UNSIGNED)) as max_number
            FROM job_cards 
            WHERE invoice_no LIKE 'INV/${year}/%'
        `);

        const maxNumber = maxResult[0]?.max_number || 8230;

        await conn.query(
            'UPDATE invoice_numbers SET last_number = ? WHERE year = ?',
            [maxNumber, year]
        );

        await conn.commit();

        res.json({
            success: true,
            message: `Fixed ${fixedCount} invoice number gaps. Current max: ${maxNumber}`,
            fixedCount,
            currentMax: maxNumber
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Fix invoice gaps error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fix invoice gaps: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// ==================== DATABASE TABLES INITIALIZATION ====================
// Add these to your initializeDatabase() function

async function initializeJobCardTables() {
    try {
        console.log('📦 Initializing job card tables...');

        await executeQuery(`
            CREATE TABLE IF NOT EXISTS job_cards (
                id VARCHAR(36) PRIMARY KEY,
                job_no VARCHAR(50) UNIQUE NOT NULL,
                date DATE NOT NULL,
                estd DATETIME NOT NULL,
                eta DATETIME NOT NULL,
                departure_location VARCHAR(200) DEFAULT 'Not Specified',
                arrival_location VARCHAR(200) DEFAULT 'Not Specified',
                cost_center VARCHAR(100) NOT NULL,
                customer_ref_no VARCHAR(100),
                requester_name VARCHAR(200) NOT NULL,
                customer_name VARCHAR(200) NOT NULL,
                customer_address TEXT NOT NULL,
                email VARCHAR(100),
                phone VARCHAR(50),
                truck_waybill_no VARCHAR(100),
                shipper_name VARCHAR(200) NOT NULL,
                shipper_ref_no VARCHAR(100),
                bayan_no VARCHAR(100),
                bayan_date DATE,
                gross_weight DECIMAL(10,2) DEFAULT 0,
                packages INT DEFAULT 0,
                package_type VARCHAR(50),
                dimensions VARCHAR(100),
                description TEXT,
                special_instructions TEXT,
                hbl VARCHAR(100) DEFAULT NULL,
                mbl VARCHAR(100) DEFAULT NULL,
                habw VARCHAR(100) DEFAULT NULL,
                mabw VARCHAR(100) DEFAULT NULL,
                road_waybill VARCHAR(100) DEFAULT NULL,
                multimodal_ref VARCHAR(100) DEFAULT NULL,
                status ENUM('draft', 'submitted', 'approved', 'rejected', 'completed') DEFAULT 'draft',
                created_by VARCHAR(100),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                submitted_at DATETIME,
                submitted_by VARCHAR(100),
                approved_at DATETIME,
                approved_by VARCHAR(100),
                completed_at DATETIME,
                invoice_no VARCHAR(100),
                INDEX idx_job_no (job_no),
                INDEX idx_status (status),
                INDEX idx_customer_name (customer_name),
                INDEX idx_shipper_name (shipper_name),
                INDEX idx_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        console.log('✅ Job cards table created/verified');

        // Customers table
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS customers (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                company VARCHAR(200) DEFAULT '',
                email VARCHAR(100) DEFAULT '',
                phone VARCHAR(50) DEFAULT '',
                address TEXT DEFAULT '',
                reference_number VARCHAR(100) DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_email (email),
                INDEX idx_phone (phone)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await executeQuery(`
            CREATE TABLE IF NOT EXISTS shippers (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                reference_number VARCHAR(100),
                phone VARCHAR(50),
                email VARCHAR(100),
                company VARCHAR(200),
                address TEXT,
                country VARCHAR(100),
                contact_person VARCHAR(200),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_reference_number (reference_number),
                INDEX idx_company (company)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await executeQuery(`
            CREATE TABLE IF NOT EXISTS consignees (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                reference_number VARCHAR(100),
                phone VARCHAR(50),
                email VARCHAR(100),
                address TEXT,
                country VARCHAR(100),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_reference_number (reference_number)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // ==================== AGENTS TABLE ====================
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS agents (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                phone VARCHAR(50) NOT NULL,
                email VARCHAR(100),
                company VARCHAR(200),
                address TEXT,
                country VARCHAR(100),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_phone (phone)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await executeQuery(`
            CREATE TABLE IF NOT EXISTS drivers (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                phone VARCHAR(50) NOT NULL,
                email VARCHAR(100),
                license_number VARCHAR(100),
                address TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_phone (phone),
                INDEX idx_license_number (license_number)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Drivers table created/verified');

        await executeQuery(`
            CREATE TABLE IF NOT EXISTS contact_persons (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                reference_number VARCHAR(100),
                phone VARCHAR(50) NOT NULL,
                email VARCHAR(100),
                company VARCHAR(200),
                consignee_id VARCHAR(36),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (consignee_id) REFERENCES consignees(id) ON DELETE SET NULL,
                INDEX idx_name (name),
                INDEX idx_phone (phone),
                INDEX idx_consignee_id (consignee_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Contact Persons table created/verified');

        await executeQuery(`
            CREATE TABLE IF NOT EXISTS invoices (
                id VARCHAR(36) PRIMARY KEY,
                invoice_no VARCHAR(100) UNIQUE NOT NULL,
                job_card_id VARCHAR(36),
                customer_id VARCHAR(36),
                date DATE NOT NULL,
                due_date DATE NOT NULL,
                subtotal DECIMAL(10,2) DEFAULT 0,
                tax DECIMAL(10,2) DEFAULT 0,
                total DECIMAL(10,2) DEFAULT 0,
                status ENUM('draft', 'sent', 'paid', 'overdue', 'cancelled') DEFAULT 'draft',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                sent_at DATETIME,
                paid_at DATETIME,
                created_by VARCHAR(100),
                notes TEXT,
                FOREIGN KEY (job_card_id) REFERENCES job_cards(id) ON DELETE SET NULL,
                INDEX idx_invoice_no (invoice_no),
                INDEX idx_status (status),
                INDEX idx_date (date)
            )
        `);

        // Invoice items table
        // Replace your current invoice_items table creation with:
        await executeQuery(`
                CREATE TABLE IF NOT EXISTS invoice_items (
                    id VARCHAR(36) PRIMARY KEY,
                    invoice_id VARCHAR(36) NOT NULL,
                    description VARCHAR(500) NOT NULL,
                    charge_type ENUM('required', 'marginal') DEFAULT 'required',
                    quantity DECIMAL(10,3) NOT NULL,
                    unit VARCHAR(50),
                    rate DECIMAL(10,3) NOT NULL,
                    amount DECIMAL(10,3) NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
                    INDEX idx_invoice_id (invoice_id),
                    INDEX idx_charge_type (charge_type)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

        console.log('✅ Job card tables initialized successfully');


        // Add to initializeDatabase() function

        await executeQuery(`
        CREATE TABLE IF NOT EXISTS job_card_numbers (
            id INT AUTO_INCREMENT PRIMARY KEY,
            year INT NOT NULL,
            last_number INT DEFAULT 0,
                current_year BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY unique_year (year),
            INDEX idx_year (year)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);



        console.log('✅ Job card numbers table created/verified');

        await initializeJobCardNumbers();
        await ensureJobCardColumns();

        await migrateLocationFields();
        await migrateBillingDocumentFields(); // Add this line



        console.log('✅ Job card numbers table created/verified');

    } catch (error) {
        console.error('❌ Job card tables initialization failed:', error.message);
        throw error;
    }
}


async function ensureJobCardColumns() {
    let conn;
    try {
        console.log('🔧 Ensuring job_cards table has all required columns...');

        conn = await getDbConnection();

        // Get current columns
        const columns = await conn.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'job_cards' 
            AND TABLE_SCHEMA = DATABASE()
        `);

        const existingColumns = columns.map(col => col.COLUMN_NAME);
        console.log('📋 Existing columns:', existingColumns.join(', '));

        // ALL columns that should exist in job_cards
        const requiredColumns = {
            // Location fields
            departure_location: 'VARCHAR(200) DEFAULT "Not Specified"',
            arrival_location: 'VARCHAR(200) DEFAULT "Not Specified"',

            // Billing document fields
            hbl: 'VARCHAR(100) DEFAULT NULL',
            mbl: 'VARCHAR(100) DEFAULT NULL',
            habw: 'VARCHAR(100) DEFAULT NULL',
            mabw: 'VARCHAR(100) DEFAULT NULL',
            road_waybill: 'VARCHAR(100) DEFAULT NULL',
            multimodal_ref: 'VARCHAR(100) DEFAULT NULL',

            // Additional fields that might be missing
            hbl_no: 'VARCHAR(100) DEFAULT NULL',
            mbl_no: 'VARCHAR(100) DEFAULT NULL',
            bayan_no: 'VARCHAR(100) DEFAULT NULL'
        };

        let addedCount = 0;

        for (const [column, definition] of Object.entries(requiredColumns)) {
            if (!existingColumns.includes(column)) {
                try {
                    await conn.query(`
                        ALTER TABLE job_cards 
                        ADD COLUMN ${column} ${definition}
                    `);
                    console.log(`✅ Added column: ${column}`);
                    addedCount++;
                } catch (err) {
                    console.log(`⚠️ Could not add ${column}: ${err.message}`);
                }
            }
        }

        // If port_arrival exists but departure_location doesn't, copy data
        if (existingColumns.includes('port_arrival') && existingColumns.includes('arrival_location')) {
            await conn.query(`
                UPDATE job_cards 
                SET arrival_location = port_arrival 
                WHERE arrival_location IS NULL OR arrival_location = 'Not Specified'
            `);
            console.log('✅ Migrated port_arrival data to arrival_location');
        }

        if (addedCount === 0) {
            console.log('✅ All required columns already exist');
        } else {
            console.log(`✅ Added ${addedCount} new columns to job_cards`);
        }

    } catch (error) {
        console.error('❌ Migration error:', error);
        throw error;
    } finally {
        if (conn) await conn.end();
    }
}

// Add to the top with other requires
const PDFDocument = require('pdfkit');

// ==================== JOB CARD SEARCH ENDPOINTS ====================

// Search job cards with filters
app.get('/api/jobcards/search', async (req, res) => {
    let conn;
    try {
        const {
            searchTerm = '',
            filters = 'all',
            limit = 50,
            page = 1
        } = req.query;

        const offset = (page - 1) * limit;
        const search = `%${searchTerm}%`;

        conn = await getDbConnection();

        let query = `
            SELECT 
                jc.id, jc.job_no, jc.invoice_no, jc.bayan_no, 
                jc.customer_ref_no, jc.port_arrival, jc.shipper_name,
                jc.customer_name, jc.date, jc.status,
                jc.gross_weight, jc.packages, jc.truck_waybill_no,
                jc.created_at,
                COALESCE(i.total, 0) as invoice_total
            FROM job_cards jc
            LEFT JOIN invoices i ON jc.job_no = i.job_card_id
            WHERE 1=1
        `;

        const params = [];

        if (searchTerm && filters !== 'all') {
            const filterMap = {
                'bayanNo': 'jc.bayan_no',
                'invoiceNo': 'jc.invoice_no',
                'customerRef': 'jc.customer_ref_no',
                'portArrival': 'jc.port_arrival',
                'shipper': 'jc.shipper_name'
            };

            if (filterMap[filters]) {
                query += ` AND ${filterMap[filters]} LIKE ?`;
                params.push(search);
            }
        } else if (searchTerm) {
            query += ` AND (
                jc.job_no LIKE ? OR 
                jc.invoice_no LIKE ? OR 
                jc.bayan_no LIKE ? OR 
                jc.customer_ref_no LIKE ? OR 
                jc.port_arrival LIKE ? OR 
                jc.shipper_name LIKE ? OR
                jc.customer_name LIKE ?
            )`;
            params.push(search, search, search, search, search, search, search);
        }

        query += ` ORDER BY jc.created_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), offset);

        const jobCards = await conn.query(query, params);

        // Get total count for pagination
        const countQuery = query.replace(
            'SELECT jc.id, jc.job_no, jc.invoice_no, jc.bayan_no, jc.customer_ref_no, jc.port_arrival, jc.shipper_name, jc.customer_name, jc.date, jc.status, jc.gross_weight, jc.packages, jc.truck_waybill_no, jc.created_at, COALESCE(i.total, 0) as invoice_total',
            'SELECT COUNT(*) as total'
        ).replace('ORDER BY jc.created_at DESC LIMIT ? OFFSET ?', '');

        const countParams = params.slice(0, -2);
        const countResult = await conn.query(countQuery, countParams);
        const total = countResult[0]?.total || 0;

        res.json({
            success: true,
            data: jobCards,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Search job cards error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to search job cards: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Get job card suggestions for search dropdown
app.get('/api/jobcards/suggestions', async (req, res) => {
    let conn;
    try {
        const { q = '', filters = 'all' } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        const search = `%${q}%`;
        conn = await getDbConnection();

        let query = `
            SELECT DISTINCT 
                jc.id, jc.job_no, jc.invoice_no, jc.bayan_no, 
                jc.customer_ref_no, jc.port_arrival, jc.shipper_name,
                jc.customer_name
            FROM job_cards jc
            WHERE 1=1
        `;

        const params = [];

        if (filters !== 'all') {
            const filterMap = {
                'bayanNo': 'jc.bayan_no',
                'invoiceNo': 'jc.invoice_no',
                'customerRef': 'jc.customer_ref_no',
                'portArrival': 'jc.port_arrival',
                'shipper': 'jc.shipper_name'
            };

            if (filterMap[filters]) {
                query += ` AND ${filterMap[filters]} LIKE ?`;
                params.push(search);
            }
        } else {
            query += ` AND (
                jc.job_no LIKE ? OR 
                jc.invoice_no LIKE ? OR 
                jc.bayan_no LIKE ? OR 
                jc.customer_ref_no LIKE ? OR 
                jc.port_arrival LIKE ? OR 
                jc.shipper_name LIKE ?
            )`;
            params.push(search, search, search, search, search, search);
        }

        query += ` LIMIT 10`;

        const suggestions = await conn.query(`
            SELECT DISTINCT 
                jc.id, jc.job_no, jc.invoice_no, jc.bayan_no, 
                jc.customer_ref_no, jc.departure_location, jc.arrival_location, jc.shipper_name,
                jc.customer_name
            FROM job_cards jc
            WHERE 1=1
        `);

        const formatted = suggestions.map(card => ({
            id: card.id,
            text: `${card.job_no} - ${card.customer_name}`,
            jobNo: card.job_no,
            invoiceNo: card.invoice_no,
            bayanNo: card.bayan_no,
            customerRef: card.customer_ref_no,
            portArrival: card.port_arrival,
            shipper: card.shipper_name
        }));

        res.json(formatted);

    } catch (error) {
        console.error('Suggestions error:', error);
        res.status(500).json([]);
    } finally {
        if (conn) await conn.end();
    }
});


// Get available charge types
app.get('/api/charge-types', async (req, res) => {
    try {
        // Define charge types (you can move this to a database table later)
        const chargeTypes = [
            { id: 'freight', name: 'Freight Charges', category: 'transport' },
            { id: 'customs', name: 'Customs Clearance', category: 'government' },
            { id: 'handling', name: 'Handling Charges', category: 'service' },
            { id: 'storage', name: 'Storage Charges', category: 'warehouse' },
            { id: 'documentation', name: 'Documentation Fees', category: 'administrative' },
            { id: 'insurance', name: 'Insurance Premium', category: 'insurance' },
            { id: 'fuel_surcharge', name: 'Fuel Surcharge', category: 'transport' },
            { id: 'port_charges', name: 'Port Charges', category: 'government' },
            { id: 'transport_local', name: 'Local Transportation', category: 'transport' },
            { id: 'consultancy', name: 'Consultancy Fees', category: 'service' },
            { id: 'packing', name: 'Packing Charges', category: 'service' },
            { id: 'inspection', name: 'Inspection Fees', category: 'government' },
            { id: 'certificate', name: 'Certificate Fees', category: 'documentation' },
            { id: 'certificate_fee', name: 'Certificate Fee', category: 'documentation' },
            { id: 'other', name: 'Other Charges', category: 'miscellaneous' }
        ];

        res.json({
            success: true,
            data: chargeTypes
        });

    } catch (error) {
        console.error('Get charge types error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get charge types'
        });
    }
});

// ==================== JOB CARD STATUS UPDATE ENDPOINTS ====================

// Update job card status with tracking details
app.put('/api/jobcards/:id/update-status', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { status, notes, trackingNumber, estimatedArrival } = req.body;
        const userId = req.user?.userId || 'system';

        if (!status) {
            return res.status(400).json({
                success: false,
                message: 'Status is required'
            });
        }

        // Map frontend status to database status
        const statusMap = {
            'transit': 'approved',      // In Transit -> approved
            'arrived': 'submitted',     // Arrived -> submitted
            'completed': 'completed'    // Completed -> completed
        };

        const dbStatus = statusMap[status] || status;

        const validStatuses = ['draft', 'submitted', 'approved', 'completed'];
        if (!validStatuses.includes(dbStatus)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status value'
            });
        }

        conn = await getDbConnection();

        // Get current job card
        const currentJobCard = await conn.query(
            'SELECT job_no, status, invoice_no FROM job_cards WHERE id = ?',
            [id]
        );

        if (currentJobCard.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Job card not found'
            });
        }

        // Build update query dynamically
        let updateFields = ['status = ?', 'updated_at = NOW()'];
        const updateValues = [dbStatus];

        switch (dbStatus) {
            case 'submitted':
                updateFields.push('submitted_at = NOW()');
                updateFields.push('submitted_by = ?');
                updateValues.push(userId);
                break;
            case 'approved':
                updateFields.push('approved_at = NOW()');
                updateFields.push('approved_by = ?');
                updateValues.push(userId);
                // Update associated invoice status to 'sent' when approved
                if (currentJobCard[0].invoice_no) {
                    await conn.query(`
                        UPDATE invoices 
                        SET status = 'sent', sent_at = NOW()
                        WHERE invoice_no = ?
                    `, [currentJobCard[0].invoice_no]);
                }
                break;
            case 'completed':
                updateFields.push('completed_at = NOW()');
                // Update associated invoice status to 'paid' if completed
                if (currentJobCard[0].invoice_no) {
                    await conn.query(`
                        UPDATE invoices 
                        SET status = 'paid', paid_at = NOW()
                        WHERE invoice_no = ?
                    `, [currentJobCard[0].invoice_no]);
                }
                break;
        }

        // Add notes if provided
        if (notes) {
            updateFields.push('special_instructions = CONCAT(IFNULL(special_instructions, ""), ?)');
            updateValues.push(`\n[${new Date().toISOString()}] Status Updated: ${status}\nNotes: ${notes}\n`);
        }

        // Add tracking number if provided
        if (trackingNumber) {
            updateFields.push('truck_waybill_no = ?');
            updateValues.push(trackingNumber);
        }

        // Add estimated arrival if provided
        if (estimatedArrival) {
            updateFields.push('eta = ?');
            updateValues.push(estimatedArrival);
        }

        updateValues.push(id);

        const query = `
            UPDATE job_cards 
            SET ${updateFields.join(', ')}
            WHERE id = ?
        `;

        await conn.query(query, updateValues);

        // Log audit
        await logAudit(userId, 'JOB_STATUS_UPDATED',
            `Job ${currentJobCard[0].job_no} status changed from ${currentJobCard[0].status} to ${dbStatus} (${status})${notes ? ' - Notes: ' + notes : ''}`, req);

        res.json({
            success: true,
            message: `Job card status updated to ${status}`,
            data: {
                job_no: currentJobCard[0].job_no,
                old_status: currentJobCard[0].status,
                new_status: dbStatus,
                display_status: status,
                notes: notes || null,
                tracking_number: trackingNumber || null,
                estimated_arrival: estimatedArrival || null,
                updated_at: new Date().toISOString()
            }
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Update job status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update job status: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Bulk update job card statuses
app.post('/api/jobcards/bulk-update-status', async (req, res) => {
    let conn;
    try {
        const { jobCardIds, status, notes } = req.body;
        const userId = req.user?.userId || 'system';

        if (!jobCardIds || !Array.isArray(jobCardIds) || jobCardIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Job card IDs are required'
            });
        }

        if (!status) {
            return res.status(400).json({
                success: false,
                message: 'Status is required'
            });
        }

        const statusMap = {
            'transit': 'approved',
            'arrived': 'submitted',
            'completed': 'completed'
        };

        const dbStatus = statusMap[status] || status;

        conn = await getDbConnection();
        await conn.beginTransaction();

        let updatedCount = 0;
        const results = [];

        for (const jobCardId of jobCardIds) {
            try {
                const currentJobCard = await conn.query(
                    'SELECT job_no, status FROM job_cards WHERE id = ?',
                    [jobCardId]
                );

                if (currentJobCard.length === 0) continue;

                let updateFields = ['status = ?', 'updated_at = NOW()'];
                const updateValues = [dbStatus];

                switch (dbStatus) {
                    case 'submitted':
                        updateFields.push('submitted_at = NOW()');
                        updateFields.push('submitted_by = ?');
                        updateValues.push(userId);
                        break;
                    case 'approved':
                        updateFields.push('approved_at = NOW()');
                        updateFields.push('approved_by = ?');
                        updateValues.push(userId);
                        if (currentJobCard[0].invoice_no) {
                            await conn.query(`
                                UPDATE invoices 
                                SET status = 'sent', sent_at = NOW()
                                WHERE invoice_no = ?
                            `, [currentJobCard[0].invoice_no]);
                        }
                        break;
                    case 'completed':
                        updateFields.push('completed_at = NOW()');
                        break;
                }

                if (notes) {
                    updateFields.push('special_instructions = CONCAT(IFNULL(special_instructions, ""), ?)');
                    updateValues.push(`\n[${new Date().toISOString()}] Bulk Status Updated: ${status}\nNotes: ${notes}\n`);
                }

                updateValues.push(jobCardId);

                await conn.query(`
                    UPDATE job_cards 
                    SET ${updateFields.join(', ')}
                    WHERE id = ?
                `, updateValues);

                updatedCount++;
                results.push({
                    id: jobCardId,
                    job_no: currentJobCard[0].job_no,
                    success: true
                });

            } catch (itemError) {
                results.push({
                    id: jobCardId,
                    success: false,
                    error: itemError.message
                });
            }
        }

        await conn.commit();

        // Log audit
        await logAudit(userId, 'BULK_JOB_STATUS_UPDATE',
            `Bulk updated ${updatedCount} job cards to status ${dbStatus} (${status})`, req);

        res.json({
            success: true,
            message: `Updated ${updatedCount} job cards to ${status}`,
            updatedCount,
            results
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Bulk update error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to bulk update statuses: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Get job card status history
app.get('/api/jobcards/:id/status-history', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        conn = await getDbConnection();

        const jobCard = await conn.query(`
            SELECT 
                job_no,
                status,
                created_at,
                submitted_at,
                submitted_by,
                approved_at,
                approved_by,
                completed_at,
                special_instructions
            FROM job_cards 
            WHERE id = ?
        `, [id]);

        if (jobCard.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Job card not found'
            });
        }

        const data = jobCard[0];

        // Build status history
        const history = [];

        if (data.created_at) {
            history.push({
                status: 'created',
                display_status: 'Created',
                timestamp: data.created_at,
                user: data.created_by || 'system',
                notes: 'Job card created'
            });
        }

        if (data.submitted_at) {
            history.push({
                status: 'submitted',
                display_status: 'Arrived',
                timestamp: data.submitted_at,
                user: data.submitted_by,
                notes: 'Shipment arrived'
            });
        }

        if (data.approved_at) {
            history.push({
                status: 'approved',
                display_status: 'In Transit',
                timestamp: data.approved_at,
                user: data.approved_by,
                notes: 'Shipment is in transit'
            });
        }

        if (data.completed_at) {
            history.push({
                status: 'completed',
                display_status: 'Completed',
                timestamp: data.completed_at,
                user: data.approved_by,
                notes: 'Shipment completed'
            });
        }

        res.json({
            success: true,
            data: {
                job_no: data.job_no,
                current_status: data.status,
                current_display_status: data.status === 'approved' ? 'In Transit' :
                    data.status === 'submitted' ? 'Arrived' :
                        data.status === 'completed' ? 'Completed' : data.status,
                history: history,
                special_instructions: data.special_instructions
            }
        });

    } catch (error) {
        console.error('Get status history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get status history: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});// ==================== JOB CARD STATUS UPDATE ENDPOINTS ====================

// Update job card status with tracking details
app.put('/api/jobcards/:id/update-status', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { status, notes, trackingNumber, estimatedArrival } = req.body;
        const userId = req.user?.userId || 'system';

        if (!status) {
            return res.status(400).json({
                success: false,
                message: 'Status is required'
            });
        }

        // Map frontend status to database status
        const statusMap = {
            'transit': 'approved',      // In Transit -> approved
            'arrived': 'submitted',     // Arrived -> submitted
            'completed': 'completed'    // Completed -> completed
        };

        const dbStatus = statusMap[status] || status;

        const validStatuses = ['draft', 'submitted', 'approved', 'completed'];
        if (!validStatuses.includes(dbStatus)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status value'
            });
        }

        conn = await getDbConnection();

        // Get current job card
        const currentJobCard = await conn.query(
            'SELECT job_no, status, invoice_no FROM job_cards WHERE id = ?',
            [id]
        );

        if (currentJobCard.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Job card not found'
            });
        }

        // Build update query dynamically
        let updateFields = ['status = ?', 'updated_at = NOW()'];
        const updateValues = [dbStatus];

        switch (dbStatus) {
            case 'submitted':
                updateFields.push('submitted_at = NOW()');
                updateFields.push('submitted_by = ?');
                updateValues.push(userId);
                break;
            case 'approved':
                updateFields.push('approved_at = NOW()');
                updateFields.push('approved_by = ?');
                updateValues.push(userId);
                // Update associated invoice status to 'sent' when approved
                if (currentJobCard[0].invoice_no) {
                    await conn.query(`
                        UPDATE invoices 
                        SET status = 'sent', sent_at = NOW()
                        WHERE invoice_no = ?
                    `, [currentJobCard[0].invoice_no]);
                }
                break;
            case 'completed':
                updateFields.push('completed_at = NOW()');
                // Update associated invoice status to 'paid' if completed
                if (currentJobCard[0].invoice_no) {
                    await conn.query(`
                        UPDATE invoices 
                        SET status = 'paid', paid_at = NOW()
                        WHERE invoice_no = ?
                    `, [currentJobCard[0].invoice_no]);
                }
                break;
        }

        // Add notes if provided
        if (notes) {
            updateFields.push('special_instructions = CONCAT(IFNULL(special_instructions, ""), ?)');
            updateValues.push(`\n[${new Date().toISOString()}] Status Updated: ${status}\nNotes: ${notes}\n`);
        }

        // Add tracking number if provided
        if (trackingNumber) {
            updateFields.push('truck_waybill_no = ?');
            updateValues.push(trackingNumber);
        }

        // Add estimated arrival if provided
        if (estimatedArrival) {
            updateFields.push('eta = ?');
            updateValues.push(estimatedArrival);
        }

        updateValues.push(id);

        const query = `
            UPDATE job_cards 
            SET ${updateFields.join(', ')}
            WHERE id = ?
        `;

        await conn.query(query, updateValues);

        // Log audit
        await logAudit(userId, 'JOB_STATUS_UPDATED',
            `Job ${currentJobCard[0].job_no} status changed from ${currentJobCard[0].status} to ${dbStatus} (${status})${notes ? ' - Notes: ' + notes : ''}`, req);

        res.json({
            success: true,
            message: `Job card status updated to ${status}`,
            data: {
                job_no: currentJobCard[0].job_no,
                old_status: currentJobCard[0].status,
                new_status: dbStatus,
                display_status: status,
                notes: notes || null,
                tracking_number: trackingNumber || null,
                estimated_arrival: estimatedArrival || null,
                updated_at: new Date().toISOString()
            }
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Update job status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update job status: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Bulk update job card statuses
app.post('/api/jobcards/bulk-update-status', async (req, res) => {
    let conn;
    try {
        const { jobCardIds, status, notes } = req.body;
        const userId = req.user?.userId || 'system';

        if (!jobCardIds || !Array.isArray(jobCardIds) || jobCardIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Job card IDs are required'
            });
        }

        if (!status) {
            return res.status(400).json({
                success: false,
                message: 'Status is required'
            });
        }

        const statusMap = {
            'transit': 'approved',
            'arrived': 'submitted',
            'completed': 'completed'
        };

        const dbStatus = statusMap[status] || status;

        conn = await getDbConnection();
        await conn.beginTransaction();

        let updatedCount = 0;
        const results = [];

        for (const jobCardId of jobCardIds) {
            try {
                const currentJobCard = await conn.query(
                    'SELECT job_no, status FROM job_cards WHERE id = ?',
                    [jobCardId]
                );

                if (currentJobCard.length === 0) continue;

                let updateFields = ['status = ?', 'updated_at = NOW()'];
                const updateValues = [dbStatus];

                switch (dbStatus) {
                    case 'submitted':
                        updateFields.push('submitted_at = NOW()');
                        updateFields.push('submitted_by = ?');
                        updateValues.push(userId);
                        break;
                    case 'approved':
                        updateFields.push('approved_at = NOW()');
                        updateFields.push('approved_by = ?');
                        updateValues.push(userId);
                        if (currentJobCard[0].invoice_no) {
                            await conn.query(`
                                UPDATE invoices 
                                SET status = 'sent', sent_at = NOW()
                                WHERE invoice_no = ?
                            `, [currentJobCard[0].invoice_no]);
                        }
                        break;
                    case 'completed':
                        updateFields.push('completed_at = NOW()');
                        break;
                }

                if (notes) {
                    updateFields.push('special_instructions = CONCAT(IFNULL(special_instructions, ""), ?)');
                    updateValues.push(`\n[${new Date().toISOString()}] Bulk Status Updated: ${status}\nNotes: ${notes}\n`);
                }

                updateValues.push(jobCardId);

                await conn.query(`
                    UPDATE job_cards 
                    SET ${updateFields.join(', ')}
                    WHERE id = ?
                `, updateValues);

                updatedCount++;
                results.push({
                    id: jobCardId,
                    job_no: currentJobCard[0].job_no,
                    success: true
                });

            } catch (itemError) {
                results.push({
                    id: jobCardId,
                    success: false,
                    error: itemError.message
                });
            }
        }

        await conn.commit();

        // Log audit
        await logAudit(userId, 'BULK_JOB_STATUS_UPDATE',
            `Bulk updated ${updatedCount} job cards to status ${dbStatus} (${status})`, req);

        res.json({
            success: true,
            message: `Updated ${updatedCount} job cards to ${status}`,
            updatedCount,
            results
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Bulk update error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to bulk update statuses: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Get job card status history
app.get('/api/jobcards/:id/status-history', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        conn = await getDbConnection();

        const jobCard = await conn.query(`
            SELECT 
                job_no,
                status,
                created_at,
                submitted_at,
                submitted_by,
                approved_at,
                approved_by,
                completed_at,
                special_instructions
            FROM job_cards 
            WHERE id = ?
        `, [id]);

        if (jobCard.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Job card not found'
            });
        }

        const data = jobCard[0];

        // Build status history
        const history = [];

        if (data.created_at) {
            history.push({
                status: 'created',
                display_status: 'Created',
                timestamp: data.created_at,
                user: data.created_by || 'system',
                notes: 'Job card created'
            });
        }

        if (data.submitted_at) {
            history.push({
                status: 'submitted',
                display_status: 'Arrived',
                timestamp: data.submitted_at,
                user: data.submitted_by,
                notes: 'Shipment arrived'
            });
        }

        if (data.approved_at) {
            history.push({
                status: 'approved',
                display_status: 'In Transit',
                timestamp: data.approved_at,
                user: data.approved_by,
                notes: 'Shipment is in transit'
            });
        }

        if (data.completed_at) {
            history.push({
                status: 'completed',
                display_status: 'Completed',
                timestamp: data.completed_at,
                user: data.approved_by,
                notes: 'Shipment completed'
            });
        }

        res.json({
            success: true,
            data: {
                job_no: data.job_no,
                current_status: data.status,
                current_display_status: data.status === 'approved' ? 'In Transit' :
                    data.status === 'submitted' ? 'Arrived' :
                        data.status === 'completed' ? 'Completed' : data.status,
                history: history,
                special_instructions: data.special_instructions
            }
        });

    } catch (error) {
        console.error('Get status history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get status history: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Save invoice with charges and advance payment
app.post('/api/jobcards/:id/save-invoice', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { charges, advancePayment, invoiceData } = req.body;
        const userId = req.user?.userId || 'system';

        conn = await getDbConnection();
        await conn.beginTransaction();

        // Get job card details
        const jobCard = await conn.query(
            'SELECT * FROM job_cards WHERE id = ?',
            [id]
        );

        if (jobCard.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Job card not found'
            });
        }

        // Check if invoice already exists
        let invoiceId = null;
        let invoiceNumber = null;

        const existingInvoice = await conn.query(
            'SELECT id, invoice_no FROM invoices WHERE job_card_id = ?',
            [id]
        );

        if (existingInvoice.length > 0) {
            invoiceId = existingInvoice[0].id;
            invoiceNumber = existingInvoice[0].invoice_no;
        } else {
            // Generate new invoice number
            invoiceNumber = await generateInvoiceNumber();
            invoiceId = uuidv4();

            // Get customer ID
            let customerId = null;
            if (jobCard[0].customer_name) {
                const customer = await conn.query(
                    'SELECT id FROM customers WHERE name = ? LIMIT 1',
                    [jobCard[0].customer_name]
                );
                if (customer.length > 0) {
                    customerId = customer[0].id;
                }
            }

            // Create invoice
            await conn.query(`
                INSERT INTO invoices (
id, invoice_no, job_card_id, customer_id,
                    date, due_date, subtotal, tax, total,
                    status, created_by, created_at, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                invoiceId,
                invoiceNumber,
                id,
                customerId,
                invoiceData.date || new Date().toISOString().split('T')[0],
                invoiceData.dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                0, // Will be calculated
                0,
                0, // Will be calculated
                'draft',
                userId,
                new Date(),
                invoiceData.notes || ''
            ]);
        }

        // Delete existing items if updating
        await conn.query('DELETE FROM invoice_items WHERE invoice_id = ?', [invoiceId]);

        // Calculate totals and save charges
        let subtotal = 0;
        for (const charge of charges) {
            const amount = parseFloat(charge.amount) || 0;
            subtotal += amount;

            await conn.query(`
                INSERT INTO invoice_items (
invoice_id, description, quantity, unit,
                    rate, amount, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
                invoiceId,
                charge.description,
                parseFloat(charge.quantity) || 1,
                charge.unit || 'each',
                parseFloat(charge.rate) || 0,
                amount,
                new Date()
            ]);
        }

        // Update invoice totals
        const total = subtotal; // Add tax if needed

        await conn.query(`
            UPDATE invoices 
            SET subtotal = ?, total = ?, updated_at = ?
            WHERE id = ?
        `, [subtotal, total, new Date(), invoiceId]);

        // Handle advance payment
        if (advancePayment && advancePayment.amount > 0) {
            const paymentId = uuidv4();

            await conn.query(`
                INSERT INTO advance_payments (
id, invoice_id, amount, payment_date, payment_method,
                    reference_number, notes, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                paymentId,
                invoiceId,
                parseFloat(advancePayment.amount) || 0,
                advancePayment.date || new Date().toISOString().split('T')[0],
                advancePayment.method || 'cash',
                advancePayment.reference || '',
                advancePayment.notes || '',
                userId,
                new Date()
            ]);

            // Update invoice status if fully paid
            if (advancePayment.amount >= total) {
                await conn.query(`
                    UPDATE invoices 
                    SET status = 'paid', 
                        paid_at = ?,
                        updated_at = ?
                    WHERE id = ?
                `, [new Date(), new Date(), invoiceId]);
            }
        }

        // Update job card with invoice number if not already set
        if (!jobCard[0].invoice_no) {
            await conn.query(
                'UPDATE job_cards SET invoice_no = ? WHERE id = ?',
                [invoiceNumber, id]
            );
        }

        await conn.commit();

        // Log audit
        await logAudit(userId, 'INVOICE_SAVED',
            `Invoice ${invoiceNumber} saved for job ${jobCard[0].job_no} with ${charges.length} charges`, req);

        res.json({
            success: true,
            message: 'Invoice saved successfully',
            invoiceNumber,
            invoiceId,
            total,
            subtotal
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Save invoice error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save invoice: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Get detailed job card info by ID
app.get('/api/jobcards/:id/details', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        conn = await getDbConnection();

        // FIXED QUERY: Only select columns that actually exist, NO COMMENTS IN SQL
        const jobCard = await conn.query(`
            SELECT 
                jc.id,
                jc.job_no,
                jc.operation_date as date,
                jc.atd as estd,
                jc.ata as eta,
                jc.pol as departure_location,
                jc.pod as arrival_location,
                jc.cost_center,
                c.reference_number as customer_ref_no,
                jc.requestor_name as requester_name,
                jc.transporter_id,
                jc.transporter_name,
                c.name as customer_name, 
                c.address as customer_address,
                c.email as email,
                c.phone as phone,
                jc.vehicle_number as truck_waybill_no,
                s.name as shipper_name,
                jc.shipper_ref_no,
                jc.declaration_number as bayan_no,
                jc.bayan_date,
                jc.gross_weight,
                jc.no_of_packages as packages,
                jc.packages_unit as package_type,
                jc.volume as dimensions,
                jc.delivery_remarks as description,
                jc.clearance_remarks as special_instructions,
                jc.hawb as hbl,
                jc.mawb as mbl,
                jc.hawb as habw,
                jc.mawb as mabw,
                jc.vehicle_number as road_waybill,
                jc.job_no as multimodal_ref,
                jc.status,
                jc.created_by,
                jc.created_at,
                jc.created_at as submitted_at,
                jc.created_by as submitted_by,
                jc.created_at as approved_at,
                jc.created_by as approved_by,
                jc.created_at as completed_at,
                jc.invoice_no as job_invoice_no,
                
                c.email as customer_email,
                c.phone as customer_phone,
                c.address as customer_address_full,
                c.company as customer_company,
                
                s.contact_person as shipper_contact,
                s.email as shipper_email,
                s.phone as shipper_phone,
                s.address as shipper_address,
                s.country as shipper_country,
                
                i.id as invoice_id,
                i.invoice_no as invoice_document_no,
                i.status as invoice_status,
                i.total as invoice_total,
                i.date as invoice_date,
                i.due_date as invoice_due_date,
                i.created_at as invoice_created_at,
                i.sent_at as invoice_sent_at,
                i.paid_at as invoice_paid_at,
                i.notes as invoice_notes,
                i.subtotal as invoice_subtotal,
                i.tax as invoice_tax,
                i.created_by as invoice_created_by
                
            FROM job_cards jc
            LEFT JOIN customers c ON jc.customer_id = c.id
            LEFT JOIN shippers s ON jc.shipper_id = s.id
            LEFT JOIN invoices i ON jc.id = i.job_card_id
            WHERE jc.id = ?
        `, [id]);

        if (jobCard.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Job card not found'
            });
        }

        // Get invoice items if invoice exists
        let invoiceItems = [];
        let advancePayments = [];

        if (jobCard[0].invoice_document_no) {
            // Get invoice items
            invoiceItems = await conn.query(`
                SELECT * FROM invoice_items 
                WHERE invoice_id = ?
                ORDER BY id
            `, [jobCard[0].invoice_id]);

            // Get advance payments
            advancePayments = await conn.query(`
                SELECT * FROM advance_payments 
                WHERE invoice_id = ?
                ORDER BY payment_date DESC
            `, [jobCard[0].invoice_id]);
        }

        // Format the response data
        const responseData = {
            // Job card data
            id: jobCard[0].id,
            job_no: jobCard[0].job_no,
            date: jobCard[0].date,
            estd: jobCard[0].estd,
            eta: jobCard[0].eta,
            departure_location: jobCard[0].departure_location,
            arrival_location: jobCard[0].arrival_location,
            cost_center: jobCard[0].cost_center,
            customer_ref_no: jobCard[0].customer_ref_no,
            requester_name: jobCard[0].requester_name,
            customer_name: jobCard[0].customer_name,
            customer_address: jobCard[0].customer_address,
            email: jobCard[0].email,
            phone: jobCard[0].phone,
            transporter_id: jobCard[0].transporter_id,   // ⬅️ ADD THIS
            transporter_name: jobCard[0].transporter_name, // ⬅️ ADD THIS
            truck_waybill_no: jobCard[0].truck_waybill_no,
            shipper_name: jobCard[0].shipper_name,
            shipper_ref_no: jobCard[0].shipper_ref_no,
            bayan_no: jobCard[0].bayan_no,
            bayan_date: jobCard[0].bayan_date,
            gross_weight: jobCard[0].gross_weight,
            packages: jobCard[0].packages,
            package_type: jobCard[0].package_type,
            dimensions: jobCard[0].dimensions,
            description: jobCard[0].description,
            special_instructions: jobCard[0].special_instructions,
            hbl: jobCard[0].hbl,
            mbl: jobCard[0].mbl,
            habw: jobCard[0].habw,
            mabw: jobCard[0].mabw,
            road_waybill: jobCard[0].road_waybill,
            multimodal_ref: jobCard[0].multimodal_ref,
            status: jobCard[0].status,
            created_by: jobCard[0].created_by,
            created_at: jobCard[0].created_at,
            submitted_at: jobCard[0].submitted_at,
            submitted_by: jobCard[0].submitted_by,
            approved_at: jobCard[0].approved_at,
            approved_by: jobCard[0].approved_by,
            completed_at: jobCard[0].completed_at,
            invoice_no: jobCard[0].job_invoice_no, // From job_cards table

            // Customer details
            customer_email: jobCard[0].customer_email,
            customer_phone: jobCard[0].customer_phone,
            customer_address_full: jobCard[0].customer_address_full,
            customer_company: jobCard[0].customer_company,

            // Shipper details
            shipper_contact: jobCard[0].shipper_contact,
            shipper_email: jobCard[0].shipper_email,
            shipper_phone: jobCard[0].shipper_phone,
            shipper_address: jobCard[0].shipper_address,
            shipper_country: jobCard[0].shipper_country,

            // Invoice details
            invoice: jobCard[0].invoice_document_no ? {
                id: jobCard[0].invoice_id,
                invoice_no: jobCard[0].invoice_document_no,
                status: jobCard[0].invoice_status,
                total: jobCard[0].invoice_total,
                subtotal: jobCard[0].invoice_subtotal,
                tax: jobCard[0].invoice_tax,
                date: jobCard[0].invoice_date,
                due_date: jobCard[0].invoice_due_date,
                created_at: jobCard[0].invoice_created_at,
                sent_at: jobCard[0].invoice_sent_at,
                paid_at: jobCard[0].invoice_paid_at,
                notes: jobCard[0].invoice_notes,
                created_by: jobCard[0].invoice_created_by,
                items: invoiceItems,
                advance_payments: advancePayments
            } : null,

            // Arrays (for backward compatibility)
            invoice_items: invoiceItems,
            advance_payments: advancePayments
        };

        res.json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Get job card details error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get job card details: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// These functions ensure dates are handled in local timezone, not UTC

function toLocalDate(dateValue) {
    if (!dateValue) return null;
    
    // If it's already in YYYY-MM-DD format, return as-is
    if (typeof dateValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
        return dateValue;
    }
    
    try {
        const date = new Date(dateValue);
        if (isNaN(date.getTime())) return null;
        
        // Get local date components without timezone conversion
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    } catch (e) {
        return null;
    }
}

function toLocalDateTime(dateValue) {
    if (!dateValue) return null;
    
    // If it's already in proper format, return as-is
    if (typeof dateValue === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateValue)) {
        return dateValue;
    }
    
    try {
        const date = new Date(dateValue);
        if (isNaN(date.getTime())) return null;
        
        // Get local components without timezone conversion
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}`;
    } catch (e) {
        return null;
    }
}

function toLocalDateTimeForDB(dateValue) {
    if (!dateValue) return null;
    
    // If it's already in YYYY-MM-DDTHH:mm format, convert to MySQL datetime
    if (typeof dateValue === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateValue)) {
        return dateValue.replace('T', ' ');
    }
    
    try {
        const date = new Date(dateValue);
        if (isNaN(date.getTime())) return null;
        
        // Format: YYYY-MM-DD HH:mm:ss (MySQL DATETIME format)
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    } catch (e) {
        return null;
    }
}

// Get job card by ID
app.get('/api/jobcards/:id/edit-details', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        conn = await getDbConnection();

        const jobCard = await conn.query(`
            SELECT 
                jc.*,
                c.name as customer_name_display,
                con.name as consignee_name,
                s.name as shipper_name_display,
                a.name as agent_name,
                t.name as transporter_name_display,
                ct.code as cargo_type_code,
                sm.code as service_mode_code,
                i.code as incoterm_code,
                cr.code as cc_regime_code,
                tm.code as transport_mode_code,
                st.code as shipment_type_code,
                rp.code as responsible_person_code
            FROM job_cards jc
            LEFT JOIN customers c ON jc.customer_id = c.id
            LEFT JOIN consignees con ON jc.consignee_id = con.id
            LEFT JOIN shippers s ON jc.shipper_id = s.id
            LEFT JOIN agents a ON jc.agent_id = a.id
            LEFT JOIN transporters t ON jc.transporter_id = t.id
            LEFT JOIN cargo_types ct ON jc.cargo_type_id = ct.id
            LEFT JOIN service_modes sm ON jc.service_mode_id = sm.id
            LEFT JOIN incoterms i ON jc.incoterm_id = i.id
            LEFT JOIN cc_regimes cr ON jc.cc_regime_id = cr.id
            LEFT JOIN transport_modes tm ON jc.transport_mode_id = tm.id
            LEFT JOIN shipment_types st ON jc.shipment_type_id = st.id
            LEFT JOIN responsible_persons rp ON jc.responsible_person_id = rp.id
            WHERE jc.id = ?
        `, [id]);

        if (jobCard.length === 0) {
            return res.status(404).json({ success: false, message: 'Job card not found' });
        }

        const result = jobCard[0];

        // Parse ministry_approval_ids
        let ministry_approvals = [];
        try {
            if (result.ministry_approval_ids) {
                ministry_approvals = typeof result.ministry_approval_ids === 'string'
                    ? JSON.parse(result.ministry_approval_ids)
                    : result.ministry_approval_ids;
            }
        } catch (e) {
            console.error("Error parsing ministry approvals:", e);
        }
        result.ministry_approval_ids = ministry_approvals;

        // Format dates in LOCAL timezone (NO UTC conversion)
        function formatLocalDate(dateValue) {
            if (!dateValue) return null;
            
            if (typeof dateValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
                return dateValue;
            }
            
            try {
                const date = new Date(dateValue);
                if (isNaN(date.getTime())) return dateValue;
                
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            } catch (e) {
                return dateValue;
            }
        }
        
        function formatLocalDateTime(dateValue) {
            if (!dateValue) return null;
            
            try {
                const date = new Date(dateValue);
                if (isNaN(date.getTime())) return dateValue;
                
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const hours = String(date.getHours()).padStart(2, '0');
                const minutes = String(date.getMinutes()).padStart(2, '0');
                return `${year}-${month}-${day}T${hours}:${minutes}`;
            } catch (e) {
                return dateValue;
            }
        }

        // Apply local date formatting to all date fields
        result.operation_date = formatLocalDate(result.operation_date);
        result.declaration_date = formatLocalDate(result.declaration_date);
        result.bayan_date = formatLocalDate(result.bayan_date);
        result.clearance_date = formatLocalDate(result.clearance_date);
        result.delivery_date = formatLocalDate(result.delivery_date);
        result.deposit_applied_date = formatLocalDate(result.deposit_applied_date);
        result.deposit_refund_last_date = formatLocalDate(result.deposit_refund_last_date);
        result.ti_bayan_expiry_date = formatLocalDate(result.ti_bayan_expiry_date);
        result.te_bayan_expiry_date = formatLocalDate(result.te_bayan_expiry_date);
        result.ata = formatLocalDate(result.ata);
        result.atd = formatLocalDateTime(result.atd);

        // Override customer_name and shipper_name with actual values
        result.customer_name = result.customer_name_display || result.customer_name || '';
        result.shipper_name = result.shipper_name_display || result.shipper_name || '';

        // Clean up
        delete result.customer_name_display;
        delete result.shipper_name_display;

        console.log('Sending dates in LOCAL format:', {
            operation_date: result.operation_date,
            declaration_date: result.declaration_date,
            bayan_date: result.bayan_date,
            atd: result.atd,
            ata: result.ata,
            transporter_id: result.transporter_id,
            transporter_name: result.transporter_name,
            transporter_name_display: result.transporter_name_display
        });

        res.json({ success: true, data: result });

    } catch (error) {
        console.error('Get job card edit details error:', error);
        res.status(500).json({ success: false, message: 'Failed to get mapped details: ' + error.message });
    } finally {
        if (conn) await conn.end();
    }
});



app.get('/api/jobcards/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        conn = await getDbConnection();

        const jobCard = await conn.query(`
            SELECT * FROM job_cards WHERE id = ?
        `, [id]);

        if (jobCard.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Job card not found'
            });
        }

        res.json({
            success: true,
            data: jobCard[0]
        });

    } catch (error) {
        console.error('Get job card error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get job card: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});



// ==================== INVOICE ENDPOINTS ====================

/// Create invoice from job card - UPDATED VERSION using invoice number generator
app.post('/api/invoices/create', async (req, res) => {
    let conn;
    try {
        const {
            jobCardId,
            invoiceData,
            charges = [],
            advancePayment // Add this parameter
        } = req.body;

        console.log('Creating invoice with data:', {
            jobCardId,
            invoiceData,
            chargesCount: charges.length,
            advancePayment
        });

        const userId = req.user?.userId || 'system';

        conn = await getDbConnection();
        await conn.beginTransaction();

        // Find job card
        let jobCard = await conn.query(
            'SELECT * FROM job_cards WHERE job_no = ? OR id = ?',
            [jobCardId, jobCardId]
        );

        if (jobCard.length === 0) {
            return res.status(404).json({
                success: false,
                message: `Job card not found: ${jobCardId}`
            });
        }

        const jobCardData = jobCard[0];

        // Check if invoice already exists for this job card
        const existingInvoice = await conn.query(
            'SELECT id, invoice_no FROM invoices WHERE job_card_id = ?',
            [jobCardData.id]
        );

        let invoiceNumber;
        let invoiceId;

        if (existingInvoice.length > 0) {
            // Update existing invoice
            invoiceId = existingInvoice[0].id;
            invoiceNumber = existingInvoice[0].invoice_no;

            console.log(`Updating existing invoice: ${invoiceNumber}`);
        } else {
            // Create new invoice
            invoiceNumber = await generateInvoiceNumber();
            invoiceId = uuidv4();

            console.log(`Creating new invoice: ${invoiceNumber}`);
        }

        // Calculate totals
        let subtotal = 0;
        charges.forEach(charge => {
            subtotal += parseFloat(charge.amount) || 0;
        });

        // Get customer ID
        let customerId = null;
        if (jobCardData.customer_name) {
            const customer = await conn.query(
                'SELECT id FROM customers WHERE name = ? LIMIT 1',
                [jobCardData.customer_name]
            );
            if (customer.length > 0) {
                customerId = customer[0].id;
            }
        }

        if (existingInvoice.length > 0) {
            // Update existing invoice
            await conn.query(`
                UPDATE invoices 
                SET subtotal = ?, tax = ?, total = ?,
                    updated_at = ?, notes = ?
                WHERE id = ?
            `, [
                subtotal,
                0,
                subtotal,
                new Date(),
                invoiceData.notes || '',
                invoiceId
            ]);

            // Delete existing items
            await conn.query('DELETE FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
        } else {
            // Create new invoice
            await conn.query(`
                INSERT INTO invoices (
id, invoice_no, job_card_id, customer_id,
                    date, due_date, subtotal, tax, total,
                    status, created_by, created_at, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                invoiceId,
                invoiceNumber,
                jobCardData.id,
                customerId,
                invoiceData.invoiceDate || new Date().toISOString().split('T')[0],
                new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                subtotal,
                0,
                subtotal,
                'draft',
                userId,
                new Date(),
                invoiceData.notes || ''
            ]);

            // Update job card with invoice number
            await conn.query(
                'UPDATE job_cards SET invoice_no = ? WHERE id = ?',
                [invoiceNumber, jobCardData.id]
            );
        }

        // Save invoice items (charges)
        for (const charge of charges) {
            await conn.query(`
                INSERT INTO invoice_items (
invoice_id, description, quantity, unit,
                    rate, amount, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
                invoiceId,
                charge.description,
                parseFloat(charge.qty) || 1,
                'each',
                parseFloat(charge.unitAmount) || 0,
                parseFloat(charge.amount) || 0,
                new Date()
            ]);
        }

        await conn.commit();

        if (advancePayment && advancePayment.amount > 0) {
            const paymentId = uuidv4();

            await conn.query(`
                INSERT INTO advance_payments (
id, invoice_id, amount, payment_date, payment_method,
                    reference_number, notes, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                paymentId,
                invoiceId,
                parseFloat(advancePayment.amount) || 0,
                advancePayment.date || new Date().toISOString().split('T')[0],
                advancePayment.method || 'cash',
                advancePayment.reference || '',
                advancePayment.notes || '',
                userId,
                new Date()
            ]);

            console.log(`Advance payment recorded: ${advancePayment.amount} for invoice ${invoiceNumber}`);

            // Update invoice status if fully paid
            const totalAdvance = parseFloat(advancePayment.amount);
            const invoiceTotal = subtotal; // Use the calculated subtotal

            if (totalAdvance >= invoiceTotal) {
                await conn.query(`
                    UPDATE invoices 
                    SET status = 'paid', 
                        paid_at = ?,
                        updated_at = ?
                    WHERE id = ?
                `, [new Date(), new Date(), invoiceId]);
            }
        }

        await conn.commit();

        // Log audit
        await logAudit(userId, 'INVOICE_CREATED',
            `Invoice created: ${invoiceNumber} for job ${jobCardData.job_no} with ${charges.length} charges`, req);

        console.log('Invoice created successfully:', invoiceNumber);

        res.json({
            success: true,
            message: 'Invoice created successfully',
            invoiceId,
            invoiceNumber,
            invoiceData: {
                ...invoiceData,
                charges,
                subtotal,
                total: subtotal,
                advancePayment: advancePayment || null
            }
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Create invoice error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create invoice: ' + error.message,
            details: error.toString()
        });
    } finally {
        if (conn) await conn.end();
    }
});

// ==================== DASHBOARD ENDPOINTS ====================

// Get comprehensive dashboard statistics
app.get('/api/dashboard/stats', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();

        // Job cards by status - CORRECTED QUERY
        const jobStats = await conn.query(`
            SELECT 
                COUNT(*) as total_job_cards,
                SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draft_job_cards,
                SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted_job_cards,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved_job_cards,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_job_cards
            FROM job_cards
        `);

        // Invoice statistics
        const invoiceStats = await conn.query(`
            SELECT 
                COUNT(*) as total_invoices,
                SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draft_invoices,
                SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_invoices,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_invoices,
                COALESCE(SUM(total), 0) as total_revenue,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END), 0) as paid_revenue
            FROM invoices
        `);

        // Recent job cards (last 10)
        const recentJobs = await conn.query(`
        SELECT 
            jc.id,
            jc.job_no,
            jc.customer_name,
            jc.departure_location,
            jc.arrival_location,
            jc.status,
            jc.created_at,
            COALESCE(i.total, 0) as invoice_total
        FROM job_cards jc
        LEFT JOIN invoices i ON jc.id = i.job_card_id
        ORDER BY jc.created_at DESC
        LIMIT 10
    `);

        // Recent invoices (last 10)
        const recentInvoices = await conn.query(`
            SELECT 
                i.*,
                jc.job_no,
                jc.customer_name,
                jc.port_arrival
            FROM invoices i
            LEFT JOIN job_cards jc ON i.job_card_id = jc.id
            ORDER BY i.created_at DESC
            LIMIT 10
        `);

        // This month's revenue
        const currentMonth = new Date().toISOString().slice(0, 7);
        const monthlyRevenue = await conn.query(`
            SELECT 
                COALESCE(SUM(total), 0) as monthly_revenue
            FROM invoices
            WHERE DATE_FORMAT(date, '%Y-%m') = ?
                AND status = 'paid'
        `, [currentMonth]);

        res.json({
            success: true,
            stats: {
                jobCards: jobStats[0] || {
                    total_job_cards: 0,
                    draft_job_cards: 0,
                    submitted_job_cards: 0,
                    approved_job_cards: 0,
                    completed_job_cards: 0
                },
                invoices: invoiceStats[0] || {
                    total_invoices: 0,
                    draft_invoices: 0,
                    sent_invoices: 0,
                    paid_invoices: 0,
                    total_revenue: 0,
                    paid_revenue: 0
                },
                monthlyRevenue: monthlyRevenue[0]?.monthly_revenue || 0
            },
            recent: {
                jobCards: recentJobs,
                invoices: recentInvoices
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load dashboard statistics',
            error: error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// ==================== ADVANCE PAYMENT ENDPOINTS ====================

// Create advance payment record
app.post('/api/advance-payments', async (req, res) => {
    let conn;
    try {
        const {
            invoiceId,
            amount,
            paymentDate,
            paymentMethod,
            referenceNumber,
            notes
        } = req.body;

        const userId = req.user?.userId || 'system';

        if (!invoiceId || !amount || !paymentDate) {
            return res.status(400).json({
                success: false,
                message: 'Invoice ID, amount, and payment date are required'
            });
        }

        conn = await getDbConnection();

        // Check if invoice exists
        const invoiceCheck = await conn.query(
            'SELECT id, total, status FROM invoices WHERE id = ?',
            [invoiceId]
        );

        if (invoiceCheck.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found'
            });
        }

        // Check if advance amount doesn't exceed invoice total
        const invoiceTotal = parseFloat(invoiceCheck[0].total) || 0;
        const advanceAmount = parseFloat(amount);

        if (advanceAmount > invoiceTotal) {
            return res.status(400).json({
                success: false,
                message: 'Advance amount cannot exceed invoice total'
            });
        }

        const paymentId = uuidv4();

        await conn.query(`
            INSERT INTO advance_payments (
id, invoice_id, amount, payment_date, payment_method,
                reference_number, notes, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            paymentId,
            invoiceId,
            advanceAmount,
            paymentDate,
            paymentMethod || 'cash',
            referenceNumber || '',
            notes || '',
            userId,
            new Date()
        ]);

        // Update invoice status to partially paid if needed
        if (advanceAmount > 0) {
            // Get total advance payments for this invoice
            const totalAdvances = await conn.query(`
                SELECT COALESCE(SUM(amount), 0) as total_advance
                FROM advance_payments
                WHERE invoice_id = ?
            `, [invoiceId]);

            const totalAdvance = parseFloat(totalAdvances[0]?.total_advance) || 0;

            if (totalAdvance >= invoiceTotal) {
                // Fully paid
                await conn.query(`
                    UPDATE invoices 
                    SET status = 'paid', 
                        paid_at = ?,
                        updated_at = ?
                    WHERE id = ?
                `, [new Date(), new Date(), invoiceId]);
            } else if (totalAdvance > 0) {
                // Partially paid - you might want to add a 'partial' status
                await conn.query(`
                    UPDATE invoices 
                    SET status = 'sent', 
                        updated_at = ?
                    WHERE id = ?
                `, [new Date(), invoiceId]);
            }
        }

        // Log audit
        await logAudit(userId, 'ADVANCE_PAYMENT_CREATED',
            `Advance payment of ${advanceAmount} recorded for invoice ${invoiceId}`, req);

        res.json({
            success: true,
            message: 'Advance payment recorded successfully',
            paymentId: paymentId,
            amount: advanceAmount
        });

    } catch (error) {
        console.error('Advance payment error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to record advance payment: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Get advance payments for an invoice
app.get('/api/invoices/:id/advance-payments', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        conn = await getDbConnection();

        const payments = await conn.query(`
            SELECT 
                ap.*,
                u.name as created_by_name
            FROM advance_payments ap
            LEFT JOIN users u ON ap.created_by = u.id
            WHERE ap.invoice_id = ?
            ORDER BY ap.payment_date DESC, ap.created_at DESC
        `, [id]);

        // Calculate total advance
        const totalAdvance = payments.reduce((sum, payment) => {
            return sum + parseFloat(payment.amount);
        }, 0);

        res.json({
            success: true,
            payments: payments,
            totalAdvance: totalAdvance,
            count: payments.length
        });

    } catch (error) {
        console.error('Get advance payments error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load advance payments'
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Get full invoice details with charges and payments
app.get('/api/invoices/:id/full', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        conn = await getDbConnection();

        // Get invoice details
        const invoice = await conn.query(`
            SELECT 
                i.*,
                jc.job_no,
                jc.customer_name,
                jc.customer_ref_no,
                jc.port_arrival,
                jc.shipper_name,
                jc.bayan_no,
                jc.gross_weight,
                jc.packages,
                c.name as customer_name, c.address as customer_address,
                c.email as customer_email,
                c.phone as customer_phone
            FROM invoices i
            LEFT JOIN job_cards jc ON i.job_card_id = jc.id
            LEFT JOIN customers c ON jc.customer_name = c.name
            WHERE i.id = ?
        `, [id]);

        if (invoice.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found'
            });
        }

        // Get invoice items/charges
        const charges = await conn.query(`
            SELECT 
                ii.*
            FROM invoice_items ii
            WHERE ii.invoice_id = ?
            ORDER BY ii.id
        `, [id]);

        // Get advance payments
        const payments = await conn.query(`
            SELECT 
                ap.*,
                u.name as created_by_name
            FROM advance_payments ap
            LEFT JOIN users u ON ap.created_by = u.id
            WHERE ap.invoice_id = ?
            ORDER BY ap.payment_date DESC
        `, [id]);

        // Calculate totals
        const totalCharges = charges.reduce((sum, charge) => {
            return sum + parseFloat(charge.amount);
        }, 0);

        const totalAdvance = payments.reduce((sum, payment) => {
            return sum + parseFloat(payment.amount);
        }, 0);

        const balance = parseFloat(invoice[0].total) - totalAdvance;

        res.json({
            success: true,
            invoice: invoice[0],
            charges: charges,
            payments: payments,
            totals: {
                charges: totalCharges,
                advance: totalAdvance,
                balance: balance,
                invoiceTotal: parseFloat(invoice[0].total) || 0
            }
        });

    } catch (error) {
        console.error('Get full invoice error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load invoice details: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Update invoice status
app.put('/api/invoices/:id/status', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { status } = req.body;
        const userId = req.user?.userId || 'system';

        if (!status) {
            return res.status(400).json({
                success: false,
                message: 'Status is required'
            });
        }

        const validStatuses = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status value'
            });
        }

        conn = await getDbConnection();

        // Get current invoice
        const currentInvoice = await conn.query(
            'SELECT invoice_no, status FROM invoices WHERE id = ?',
            [id]
        );

        if (currentInvoice.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found'
            });
        }

        // Update invoice status
        const updateData = {
            status: status,
            updated_at: new Date()
        };

        // Set paid_at if status is 'paid'
        if (status === 'paid') {
            updateData.paid_at = new Date();
        }

        // Set sent_at if status is 'sent' and not already set
        if (status === 'sent' && !currentInvoice[0].sent_at) {
            updateData.sent_at = new Date();
        }

        await conn.query(`
            UPDATE invoices 
            SET status = ?,
                ${status === 'paid' ? 'paid_at = ?,' : ''}
                ${status === 'sent' && !currentInvoice[0].sent_at ? 'sent_at = ?,' : ''}
                updated_at = ?
            WHERE id = ?
        `, [
            status,
            ...(status === 'paid' ? [new Date()] : []),
            ...(status === 'sent' && !currentInvoice[0].sent_at ? [new Date()] : []),
            new Date(),
            id
        ]);

        // Log audit
        await logAudit(userId, 'INVOICE_STATUS_UPDATED',
            `Invoice ${currentInvoice[0].invoice_no} status changed from ${currentInvoice[0].status} to ${status}`, req);

        res.json({
            success: true,
            message: 'Invoice status updated successfully',
            invoiceNo: currentInvoice[0].invoice_no,
            oldStatus: currentInvoice[0].status,
            newStatus: status
        });

    } catch (error) {
        console.error('Update invoice status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update invoice status: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Get all job cards for board view
// Get all job cards for board view
app.get('/api/jobcards', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();

        const jobCards = await conn.query(`
            SELECT 
                jc.id,
                jc.job_no,
                jc.operation_date as date,
                jc.atd as estd,
                jc.ata as eta,
                jc.pol as departure_location,
                jc.pod as arrival_location,
                jc.cost_center,
                c.reference_number as customer_ref_no,
                jc.requestor_name as requester_name,
                jc.transporter_id,
                jc.transporter_name,
                t.name as transporter_display,
                c.name as customer_name, 
                c.address as customer_address,
                c.email as email,
                c.phone as phone,
                jc.vehicle_number as truck_waybill_no,
                s.name as shipper_name,
                jc.shipper_ref_no,
                jc.bayan_no,
                jc.declaration_number,
                jc.bayan_date,
                jc.gross_weight,
                jc.no_of_packages as packages,
                jc.packages_unit as package_type,
                jc.volume as dimensions,
                jc.delivery_remarks as description,
                jc.clearance_remarks as special_instructions,
                jc.hawb as hbl,
                jc.mawb as mbl,
                jc.hawb as habw,
                jc.mawb as mabw,
                jc.vehicle_number as road_waybill,
                jc.job_no as multimodal_ref,
                jc.status,
                jc.created_by,
                jc.created_at,
                jc.created_at as submitted_at,
                jc.created_by as submitted_by,
                jc.created_at as approved_at,
                jc.created_by as approved_by,
                jc.created_at as completed_at,
                jc.invoice_no,
                COALESCE(i.total, 0) as invoice_total,
                COALESCE(i.status, 'draft') as invoice_status,
                (SELECT SUM(amount) FROM advance_payments ap WHERE ap.invoice_id = i.id) as advance_payment
            FROM job_cards jc
            LEFT JOIN customers c ON jc.customer_id = c.id
            LEFT JOIN shippers s ON jc.shipper_id = s.id
            LEFT JOIN invoices i ON jc.id = i.job_card_id
            LEFT JOIN transporters t ON jc.transporter_id = t.id
            ORDER BY jc.created_at DESC
        `);

        res.json({
            success: true,
            data: jobCards
        });

    } catch (error) {
        console.error('Get job cards error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get job cards: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// ==================== JOB CARD STATUS ENDPOINTS ====================

// Update job card status
app.put('/api/jobcards/:id/status', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { status } = req.body;
        const userId = req.user?.userId || 'system';

        if (!status) {
            return res.status(400).json({
                success: false,
                message: 'Status is required'
            });
        }

        const validStatuses = ['draft', 'submitted', 'approved', 'rejected', 'completed'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status value'
            });
        }

        conn = await getDbConnection();

        // Get current job card
        const currentJobCard = await conn.query(
            'SELECT job_no, status FROM job_cards WHERE id = ?',
            [id]
        );

        if (currentJobCard.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Job card not found'
            });
        }

        // Update job card status with appropriate timestamps
        const updateData = {
            status: status,
            updated_at: new Date()
        };

        // Set appropriate timestamp based on status
        switch (status) {
            case 'submitted':
                updateData.submitted_at = new Date();
                updateData.submitted_by = userId;
                break;
            case 'approved':
                updateData.approved_at = new Date();
                updateData.approved_by = userId;
                break;
            case 'completed':
                updateData.completed_at = new Date();
                break;
        }

        await conn.query(`
            UPDATE job_cards 
            SET status = ?,
                ${status === 'submitted' ? 'submitted_at = ?, submitted_by = ?,' : ''}
                ${status === 'approved' ? 'approved_at = ?, approved_by = ?,' : ''}
                ${status === 'completed' ? 'completed_at = ?,' : ''}
                updated_at = ?
            WHERE id = ?
        `, [
            status,
            ...(status === 'submitted' ? [new Date(), userId] : []),
            ...(status === 'approved' ? [new Date(), userId] : []),
            ...(status === 'completed' ? [new Date()] : []),
            new Date(),
            id
        ]);

        // Log audit
        await logAudit(userId, 'JOB_CARD_STATUS_UPDATED',
            `Job card ${currentJobCard[0].job_no} status changed from ${currentJobCard[0].status} to ${status}`, req);

        res.json({
            success: true,
            message: 'Job card status updated successfully',
            jobNo: currentJobCard[0].job_no,
            oldStatus: currentJobCard[0].status,
            newStatus: status
        });

    } catch (error) {
        console.error('Update job card status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update job card status: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Get job cards by status
app.get('/api/jobcards/status/:status', async (req, res) => {
    let conn;
    try {
        const { status } = req.params;
        const { limit = 50, page = 1 } = req.query;
        const offset = (page - 1) * limit;

        const validStatuses = ['draft', 'submitted', 'approved', 'rejected', 'completed'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status value'
            });
        }

        conn = await getDbConnection();

        const jobCards = await conn.query(`
            SELECT 
                jc.*,
                COALESCE(i.total, 0) as invoice_total,
                i.status as invoice_status
            FROM job_cards jc
            LEFT JOIN invoices i ON jc.id = i.job_card_id
            WHERE jc.status = ?
            ORDER BY jc.created_at DESC
            LIMIT ? OFFSET ?
        `, [status, parseInt(limit), offset]);

        // Get total count
        const countResult = await conn.query(`
            SELECT COUNT(*) as total
            FROM job_cards
            WHERE status = ?
        `, [status]);

        const total = countResult[0]?.total || 0;

        res.json({
            success: true,
            data: jobCards,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit),
                status: status
            }
        });

    } catch (error) {
        console.error('Get job cards by status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load job cards: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});


// Get all invoices
// Get all invoices - FIXED VERSION
app.get('/api/invoices', async (req, res) => {
    let conn;
    try {
        const { limit = 50, page = 1, status } = req.query;
        const offset = (page - 1) * limit;

        conn = await getDbConnection();

        let query = `
            SELECT 
                i.*,
                jc.job_no,
                
                s.name as shipper_name,
                jc.port_arrival,
                (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) as item_count,
                (SELECT SUM(ii.amount) FROM invoice_items ii WHERE ii.invoice_id = i.id) as total_amount
            FROM invoices i
            LEFT JOIN job_cards jc ON i.job_card_id = jc.id
            LEFT JOIN customers c ON jc.customer_id = c.id
            LEFT JOIN shippers s ON jc.shipper_id = s.id
            WHERE 1=1
        `;

        const params = [];

        if (status) {
            query += ` AND i.status = ?`;
            params.push(status);
        }

        query += ` ORDER BY i.created_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), offset);

        console.log('Executing invoice query:', query, params);
        const invoices = await conn.query(query, params);

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total
            FROM invoices i
            WHERE 1=1 ${status ? ' AND i.status = ?' : ''}
        `;

        const countResult = await conn.query(countQuery, status ? [status] : []);
        const total = countResult[0]?.total || 0;

        console.log(`Found ${invoices.length} invoices, total: ${total}`);

        res.json({
            success: true,
            data: invoices,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Get invoices error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get invoices: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});
// Get invoice by ID
app.get('/api/invoices/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        conn = await getDbConnection();

        const invoice = await conn.query(`
            SELECT 
                i.*,
                jc.*,
                c.name as customer_name_full,
                c.address as customer_address_full,
                c.email as customer_email,
                c.phone as customer_phone
            FROM invoices i
            LEFT JOIN job_cards jc ON i.job_card_id = jc.id
            LEFT JOIN customers c ON jc.customer_name = c.name
            WHERE i.id = ?
        `, [id]);

        if (invoice.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found'
            });
        }

        const invoiceItems = await conn.query(`
            SELECT * FROM invoice_items 
            WHERE invoice_id = ?
            ORDER BY id
        `, [id]);

        res.json({
            success: true,
            data: {
                ...invoice[0],
                items: invoiceItems
            }
        });

    } catch (error) {
        console.error('Get invoice error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get invoice: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Update invoice
app.put('/api/invoices/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { invoiceData, charges } = req.body;
        const userId = req.user?.userId || 'system';

        conn = await getDbConnection();
        await conn.beginTransaction();

        // Update invoice
        await conn.query(`
            UPDATE invoices 
            SET date = ?, due_date = ?, subtotal = ?, total = ?,
                status = ?, notes = ?, updated_at = ?
            WHERE id = ?
        `, [
            invoiceData.date,
            invoiceData.dueDate,
            invoiceData.subtotal,
            invoiceData.total,
            invoiceData.status || 'draft',
            invoiceData.notes || '',
            new Date(),
            id
        ]);

        // Delete existing items and insert new ones
        await conn.query('DELETE FROM invoice_items WHERE invoice_id = ?', [id]);

        for (const charge of charges) {
            await conn.query(`
                INSERT INTO invoice_items (
invoice_id, description, quantity, unit,
                    rate, amount, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
                id,
                charge.description,
                parseFloat(charge.qty) || 1,
                'each',
                parseFloat(charge.unitAmount) || 0,
                parseFloat(charge.amount) || 0,
                new Date()
            ]);
        }

        await conn.commit();

        // Log audit
        await logAudit(userId, 'INVOICE_UPDATED', `Invoice updated: ${id}`, req);

        res.json({
            success: true,
            message: 'Invoice updated successfully'
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Update invoice error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update invoice: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Delete invoice
app.delete('/api/invoices/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const userId = req.user?.userId || 'system';

        conn = await getDbConnection();

        // Get invoice info for audit
        const invoice = await conn.query('SELECT invoice_no FROM invoices WHERE id = ?', [id]);

        // Delete invoice (cascade will delete items)
        await conn.query('DELETE FROM invoices WHERE id = ?', [id]);

        // Log audit
        await logAudit(userId, 'INVOICE_DELETED', `Invoice deleted: ${invoice[0]?.invoice_no || id}`, req);

        res.json({
            success: true,
            message: 'Invoice deleted successfully'
        });

    } catch (error) {
        console.error('Delete invoice error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete invoice: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});


function getJobTypeDetails(jobNo) {
    if (!jobNo) return { type: 'road', is_sea: false, is_air: false, is_road: true };

    const upperJobNo = jobNo.toUpperCase();

    if (upperJobNo.startsWith('SEA')) {
        return { type: 'sea', is_sea: true, is_air: false, is_road: false };
    }
    else if (upperJobNo.startsWith('AIR')) {
        return { type: 'air', is_sea: false, is_air: true, is_road: false };
    }
    else {
        return { type: 'road', is_sea: false, is_air: false, is_road: true };
    }
}
// ==================== PDF GENERATION ENDPOINT - USING PUPPETEER + HANDLEBARS ====================

// Register Handlebars helpers (place these at the top of your file after requiring handlebars)

handlebars.registerHelper('formatCurrency', function (value) {
    if (value === null || value === undefined) return '0.000';
    return parseFloat(value).toLocaleString('en-US', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3
    });
});


// register helpers
handlebars.registerHelper("eq", (a, b) => a === b);
handlebars.registerHelper("add", (a, b) => a + b);


handlebars.registerHelper('formatNumber', function (value) {
    if (value === null || value === undefined) return '0';
    return parseFloat(value).toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    });
});


function amountToKwdWords(amount) {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    function wholeNumberToWords(value) {
        if (value === 0) return 'Zero';
        if (value < 20) return teens[value - 10] || ones[value];
        if (value < 100) {
            const ten = Math.floor(value / 10);
            const unit = value % 10;
            return tens[ten] + (unit > 0 ? '-' + ones[unit] : '');
        }
        if (value < 1000) {
            const hundred = Math.floor(value / 100);
            const remainder = value % 100;
            // ONLY add "and" if there's a remainder
            return ones[hundred] + ' Hundred' + (remainder > 0 ? ' ' + wholeNumberToWords(remainder) : '');
        }
        if (value < 1000000) {
            const thousand = Math.floor(value / 1000);
            const remainder = value % 1000;
            return wholeNumberToWords(thousand) + ' Thousand' + (remainder > 0 ? ' ' + wholeNumberToWords(remainder) : '');
        }
        if (value < 1000000000) {
            const million = Math.floor(value / 1000000);
            const remainder = value % 1000000;
            return wholeNumberToWords(million) + ' Million' + (remainder > 0 ? ' ' + wholeNumberToWords(remainder) : '');
        }
        return 'Number too large';
    }

    // Handle negative numbers
    if (amount < 0) return 'Negative ' + amountToKwdWords(Math.abs(amount));

    // Parse the amount with proper decimal handling
    const numStr = Number(amount).toFixed(3);
    const parts = numStr.split('.');
    const dinars = parseInt(parts[0]) || 0;
    const fils = parseInt(parts[1]) || 0;

    if (dinars === 0 && fils === 0) return 'Zero Dinars and Zero Fils Only';

    let result = '';
    
    // Dinars part
    if (dinars > 0) {
        result += wholeNumberToWords(dinars) + ' Dinar' + (dinars > 1 ? 's' : '');
    }

    // Fils part
    if (fils > 0) {
        if (dinars > 0) {
            result += ' and ';
        }
        result += wholeNumberToWords(fils) + ' Fil' + (fils > 1 ? 's' : '');
    }

    return result + ' Only';
}

const convertNumberToWords = amountToKwdWords;

handlebars.registerHelper('add', function (a, b) {
    return (parseInt(a) || 0) + (parseInt(b) || 0);
});



// PDF Generation Endpoint - Using Puppeteer + Handlebars
// PDF Generation Endpoint - Shows BOTH Required and Marginal Charges
// app.get('/api/invoices/:id/pdf', async (req, res) => {
//     const { id } = req.params;
//     queuePDFRequest(id, res, 'invoice');
// });
// PDF Generation Endpoint - Using Puppeteer + Handlebars
// PDF Generation Endpoint - Shows BOTH Required and Marginal Charges
app.get('/api/invoices/:id/pdf', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        conn = await getDbConnection();

        // Fetch complete invoice data
        const invoiceData = await conn.query(`
            SELECT 
                i.id as invoice_id,
                i.invoice_no,
                i.date as invoice_date,
                i.due_date,
                i.subtotal,
                i.tax,
                i.total,
                i.discount_amount,
                i.discount_reason,
                i.notes,
                jc.id as job_card_id,
                jc.job_no,
                jc.atd as estd,
                jc.ata as eta,
                jc.pol as departure_location,
                jc.pod as arrival_location,
                jc.cost_center,
                jc.cost_center_number,
                jc.commercial_invoice_no,
                c.reference_number as customer_ref_no,
                jc.requestor_name as requester_name,
                c.name as customer_name, 
                c.address as customer_address,
                c.email as email,
                c.phone as phone,
                jc.vehicle_number as truck_waybill_no,
                s.name as shipper_name,
                jc.shipper_ref_no,
                jc.declaration_number as bayan_no,
                jc.bayan_date,
                jc.gross_weight,
                jc.no_of_packages as packages,
                jc.packages_unit as package_type,
                jc.hawb as hbl,
                jc.mawb as mbl,
                jc.hawb as habw,
                jc.mawb as mabw,
                jc.vehicle_number as road_waybill,
                jc.job_no as multimodal_ref,
                jc.status as job_status,
                jc.invoice_no as job_invoice_no
            FROM invoices i
            LEFT JOIN job_cards jc ON i.job_card_id = jc.id
            LEFT JOIN customers c ON jc.customer_id = c.id
            LEFT JOIN shippers s ON jc.shipper_id = s.id
            WHERE i.id = ?
        `, [id]);

        if (invoiceData.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found'
            });
        }

        const invoice = invoiceData[0];

        // Fetch ALL charges (both required and marginal)
        let allCharges = await conn.query(`
            SELECT description, quantity, unit, rate, amount, charge_type
            FROM invoice_items 
            WHERE invoice_id = ?
            ORDER BY id
        `, [id]);

        // ============================================================
        // SORT: Marginal first, then required
        // ============================================================
        allCharges.sort((a, b) => {
            const aIsMarginal = (a.charge_type === 'marginal');
            const bIsMarginal = (b.charge_type === 'marginal');
            if (aIsMarginal && !bIsMarginal) return -1;
            if (!aIsMarginal && bIsMarginal) return 1;
            return (a.description || '').localeCompare(b.description || '');
        });

        // ============================================================
        // PAGINATE: Max 20 charges per page
        // ============================================================
        const MAX_CHARGES_PER_PAGE = 20;
        const chargePages = [];
        for (let i = 0; i < allCharges.length; i += MAX_CHARGES_PER_PAGE) {
            chargePages.push(allCharges.slice(i, i + MAX_CHARGES_PER_PAGE));
        }

        // Calculate totals
        const totalCharges = allCharges.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);

        // Get discount data
        const discountAmount = parseFloat(invoice.discount_amount) || 0;
        const discountReason = invoice.discount_reason || '';
        const netTotal = totalCharges - discountAmount;

        // Fetch advance payment
        const advanceResult = await conn.query(`
            SELECT COALESCE(SUM(amount), 0) as total_advance
            FROM advance_payments 
            WHERE invoice_id = ?
        `, [id]);

        const advancePayment = parseFloat(advanceResult[0]?.total_advance) || 0;
        const invoiceTotal = parseFloat(invoice.total) || netTotal;
        const balanceDue = Math.max(invoiceTotal - advancePayment, 0);
        const creditsBalance = Math.max(advancePayment - invoiceTotal, 0);

        // Determine job type
        const jobNo = invoice.job_no || '';
        const isSea = jobNo.toUpperCase().startsWith('SEA');
        const isAir = jobNo.toUpperCase().startsWith('AIR');
        const isRoad = !isSea && !isAir;

        // Format date helper
        const formatDate = (date) => {
            if (!date) return 'N/A';
            const d = new Date(date);
            return d.toLocaleDateString('en-GB');
        };

        // ============================================================
        // LOAD LOGO AS BASE64
        // ============================================================
        let logoBase64 = '';
        try {
            const logoPaths = [
                path.join(__dirname, 'logo.svg'),
                path.join(__dirname, '..', 'logo.svg'),
                path.join(__dirname, 'logo.png'),
                path.join(__dirname, '..', 'logo.png'),
                path.join(__dirname, 'logo.jpg'),
                path.join(__dirname, '..', 'logo.jpg'),
                path.join(__dirname, '..', '..', 'logo.svg'),
                path.join(__dirname, '..', '..', 'logo.png')
            ];

            for (const logoPath of logoPaths) {
                if (fs.existsSync(logoPath)) {
                    const ext = path.extname(logoPath).toLowerCase();
                    let mimeType = 'image/svg+xml';
                    if (ext === '.png') mimeType = 'image/png';
                    else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                    
                    const data = fs.readFileSync(logoPath);
                    logoBase64 = `data:${mimeType};base64,` + data.toString('base64');
                    console.log(`✅ Logo loaded from: ${logoPath}`);
                    break;
                }
            }
            
            if (!logoBase64) {
                console.log('⚠️ Logo not found in any of the expected paths');
            }
        } catch (err) {
            console.log('⚠️ Logo loading error:', err.message);
        }

        // ============================================================
        // PREPARE TEMPLATE DATA WITH PAGINATION, LOGO AND DISCOUNT
        // ============================================================
        const templateData = {
            // Invoice details
            invoice_no: invoice.invoice_no || 'N/A',
            invoice_date: formatDate(invoice.invoice_date),
            due_date: formatDate(invoice.due_date),

            // Job details
            job_no: invoice.job_no || 'N/A',
            requester_name: invoice.requester_name || 'N/A',
            cost_center: invoice.cost_center || 'N/A',
            cost_center_number: invoice.cost_center_number || 'N/A',

            // Job type flags
            is_sea: isSea,
            is_air: isAir,
            is_road: isRoad,

            // Logo
            logo: logoBase64,

            // Customer details
            customer_name: invoice.customer_name || 'N/A',
            customer_address: invoice.customer_address || '',
            customer_phone: invoice.phone || 'N/A',
            customer_email: invoice.email || 'N/A',
            customer_ref_no: invoice.customer_ref_no || '',

            // Shipment details
            truck_waybill_no: invoice.truck_waybill_no || 'N/A',
            etd: formatDate(invoice.estd),
            eta: formatDate(invoice.eta),
            departure_location: invoice.departure_location || 'N/A',
            arrival_location: invoice.arrival_location || 'N/A',
            shipper_name: invoice.shipper_name || 'N/A',
            shipper_ref_no: invoice.shipper_ref_no || 'N/A',
            commercial_invoice_no: invoice.commercial_invoice_no || 'N/A',

            // Customs details
            bayan_no: invoice.bayan_no || 'N/A',
            bayan_date: formatDate(invoice.bayan_date),
            gross_weight: invoice.gross_weight || '0',
            packages: invoice.packages || '0',
            package_type: invoice.package_type || 'Units',

            // Billing Documents
            hbl: invoice.hbl || 'Not issued',
            mbl: invoice.mbl || 'Not issued',
            habw: invoice.habw || 'Not issued',
            mabw: invoice.mabw || 'Not issued',
            road_waybill: invoice.road_waybill || 'Not issued',
            multimodal_ref: invoice.multimodal_ref || '',

            // ============================================================
            // CHARGES WITH PAGINATION
            // ============================================================
            all_charges: allCharges,
            chargePages: chargePages,
            totalPages: chargePages.length,
            total_charges: totalCharges,

            // ============================================================
            // DISCOUNT DATA
            // ============================================================
            discount_amount: discountAmount,
            discount_reason: discountReason,
            net_total: netTotal,

            // ============================================================
            // PAYMENT DATA
            // ============================================================
            advance_payment: advancePayment,
            balance_due: balanceDue,
            credits_balance: creditsBalance,

            // Company info
            company_phone: process.env.COMPANY_PHONE || '+965 24311005/6',
            company_email: process.env.COMPANY_EMAIL || 'sales@aleidlogistics.com',

            // Year
            year: new Date().getFullYear()
        };

        // Add amount in words (use net total after discount)
        templateData.amount_in_words = convertNumberToWords(netTotal);

        // Read and compile template
        const templatePath = path.join(__dirname, 'invoice-template.hbs');
        const templateHtml = fs.readFileSync(templatePath, 'utf8');
        const template = handlebars.compile(templateHtml);
        const html = template(templateData);

        // Generate PDF
        const browser = await puppeteer.launch({
            headless: true,
            executablePath: getChromeExecutablePath(),
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();
        await page.setContent(html, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '15px', bottom: '15px', left: '15px', right: '15px' },
            preferCSSPageSize: true
        });

        await browser.close();

        // Send PDF
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="INVOICE_${invoice.invoice_no}.pdf"`);
        res.setHeader('Content-Length', pdf.length);
        res.send(pdf);

    } catch (error) {
        console.error('PDF generation error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: 'Failed to generate PDF: ' + error.message
            });
        }
    } finally {
        if (conn) await conn.end();
    }
});


// Rename your current generateInvoicePDF to generateInvoicePDFWithBrowser
// ==================== INVOICE PDF GENERATION WITH QUEUE ====================
async function generateInvoicePDFWithBrowser(id, res, browser) {
    let conn;
    try {
        conn = await getDbConnection();

        // ✅ CORRECTED QUERY - NO DUPLICATE FIELDS
        const invoiceData = await conn.query(`
            SELECT 
                i.id as invoice_id,
                i.invoice_no,
                i.date as invoice_date,
                i.due_date,
                i.subtotal,
                i.tax,
                i.total,
                i.discount_amount,
                i.discount_reason,
                i.notes,
                i.status as invoice_status,
                jc.id as job_card_id,
                jc.job_no,
                jc.atd as estd,
                jc.ata as eta,
                jc.pol as departure_location,
                jc.pod as arrival_location,
                jc.cost_center,
                jc.cost_center_number,
                jc.commercial_invoice_no,
                jc.requestor_name as requester_name,
                jc.vehicle_number as truck_waybill_no,
                jc.shipper_ref_no,
                jc.declaration_number as bayan_no,
                jc.bayan_date,
                jc.gross_weight,
                jc.no_of_packages as packages,
                jc.packages_unit as package_type,
                jc.hawb as hbl,
                jc.mawb as mbl,
                jc.hawb as habw,
                jc.mawb as mabw,
                jc.vehicle_number as road_waybill,
                jc.job_no as multimodal_ref,
                jc.status as job_status,
                jc.invoice_no as job_invoice_no,
                jc.master_remarks,
                c.name as customer_name,
                c.address as customer_address,
                c.email as email,
                c.phone as phone,
                c.reference_number as customer_ref_no,
                s.name as shipper_name
            FROM invoices i
            LEFT JOIN job_cards jc ON i.job_card_id = jc.id
            LEFT JOIN customers c ON jc.customer_id = c.id
            LEFT JOIN shippers s ON jc.shipper_id = s.id
            WHERE i.id = ?
        `, [id]);

        if (invoiceData.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found'
            });
        }

        const invoice = invoiceData[0];

        // Fetch ALL charges
        let allCharges = await conn.query(`
            SELECT description, quantity, unit, rate, amount, charge_type
            FROM invoice_items 
            WHERE invoice_id = ?
            ORDER BY id
        `, [id]);

        // Sort: Marginal first, then required
        allCharges.sort((a, b) => {
            const aIsMarginal = (a.charge_type === 'marginal');
            const bIsMarginal = (b.charge_type === 'marginal');
            if (aIsMarginal && !bIsMarginal) return -1;
            if (!aIsMarginal && bIsMarginal) return 1;
            return (a.description || '').localeCompare(b.description || '');
        });

        // Paginate: Max 20 charges per page
        const MAX_CHARGES_PER_PAGE = 20;
        const chargePages = [];
        for (let i = 0; i < allCharges.length; i += MAX_CHARGES_PER_PAGE) {
            chargePages.push(allCharges.slice(i, i + MAX_CHARGES_PER_PAGE));
        }

        // Calculate totals
        const totalCharges = allCharges.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);

        // Get discount data
        const discountAmount = parseFloat(invoice.discount_amount) || 0;
        const discountReason = invoice.discount_reason || '';
        const netTotal = totalCharges - discountAmount;

        // Fetch advance payment
        const advanceResult = await conn.query(`
            SELECT COALESCE(SUM(amount), 0) as total_advance
            FROM advance_payments 
            WHERE invoice_id = ?
        `, [id]);

        const advancePayment = parseFloat(advanceResult[0]?.total_advance) || 0;
        const invoiceTotal = parseFloat(invoice.total) || netTotal;
        const balanceDue = Math.max(invoiceTotal - advancePayment, 0);
        const creditsBalance = Math.max(advancePayment - invoiceTotal, 0);

        // Determine job type
        const jobNo = invoice.job_no || '';
        const isSea = jobNo.toUpperCase().startsWith('SEA');
        const isAir = jobNo.toUpperCase().startsWith('AIR');
        const isRoad = !isSea && !isAir;

        // Format date helper
        const formatDate = (date) => {
            if (!date) return 'N/A';
            const d = new Date(date);
            return d.toLocaleDateString('en-GB');
        };

        // Load logo as base64
        let logoBase64 = '';
        try {
            const logoPaths = [
                path.join(__dirname, 'logo.svg'),
                path.join(__dirname, '..', 'logo.svg'),
                path.join(__dirname, 'logo.png'),
                path.join(__dirname, '..', 'logo.png'),
                path.join(__dirname, 'logo.jpg'),
                path.join(__dirname, '..', 'logo.jpg'),
                path.join(__dirname, '..', '..', 'logo.svg'),
                path.join(__dirname, '..', '..', 'logo.png')
            ];

            for (const logoPath of logoPaths) {
                if (fs.existsSync(logoPath)) {
                    const ext = path.extname(logoPath).toLowerCase();
                    let mimeType = 'image/svg+xml';
                    if (ext === '.png') mimeType = 'image/png';
                    else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                    
                    const data = fs.readFileSync(logoPath);
                    logoBase64 = `data:${mimeType};base64,` + data.toString('base64');
                    console.log(`✅ Logo loaded from: ${logoPath}`);
                    break;
                }
            }
            
            if (!logoBase64) {
                console.log('⚠️ Logo not found in any of the expected paths');
            }
        } catch (err) {
            console.log('⚠️ Logo loading error:', err.message);
        }

        // Prepare template data
        const templateData = {
            invoice_no: invoice.invoice_no || 'N/A',
            invoice_date: formatDate(invoice.invoice_date),
            due_date: formatDate(invoice.due_date),
            job_no: invoice.job_no || 'N/A',
            requester_name: invoice.requester_name || 'N/A',
            cost_center: invoice.cost_center || 'N/A',
            cost_center_number: invoice.cost_center_number || 'N/A',
            is_sea: isSea,
            is_air: isAir,
            is_road: isRoad,
            logo: logoBase64,
            customer_name: invoice.customer_name || 'N/A',
            customer_address: invoice.customer_address || '',
            customer_phone: invoice.phone || 'N/A',
            customer_email: invoice.email || 'N/A',
            customer_ref_no: invoice.customer_ref_no || '',
            truck_waybill_no: invoice.truck_waybill_no || 'N/A',
            etd: formatDate(invoice.estd),
            eta: formatDate(invoice.eta),
            departure_location: invoice.departure_location || 'N/A',
            arrival_location: invoice.arrival_location || 'N/A',
            shipper_name: invoice.shipper_name || 'N/A',
            shipper_ref_no: invoice.shipper_ref_no || 'N/A',
            commercial_invoice_no: invoice.commercial_invoice_no || 'N/A',
            bayan_no: invoice.bayan_no || 'N/A',
            bayan_date: formatDate(invoice.bayan_date),
            gross_weight: invoice.gross_weight || '0',
            packages: invoice.packages || '0',
            package_type: invoice.package_type || 'Units',
            hbl: invoice.hbl || 'Not issued',
            mbl: invoice.mbl || 'Not issued',
            habw: invoice.habw || 'Not issued',
            mabw: invoice.mabw || 'Not issued',
            road_waybill: invoice.road_waybill || 'Not issued',
            multimodal_ref: invoice.multimodal_ref || '',
            all_charges: allCharges,
            chargePages: chargePages,
            totalPages: chargePages.length,
            total_charges: totalCharges,
            discount_amount: discountAmount,
            discount_reason: discountReason,
            net_total: netTotal,
            advance_payment: advancePayment,
            balance_due: balanceDue,
            credits_balance: creditsBalance,
            company_phone: process.env.COMPANY_PHONE || '+965 24311005/6',
            company_email: process.env.COMPANY_EMAIL || 'sales@aleidlogistics.com',
            year: new Date().getFullYear(),
            amount_in_words: convertNumberToWords(netTotal)
        };

        // Read and compile template
        const templatePath = path.join(__dirname, 'invoice-template.hbs');
        const templateHtml = fs.readFileSync(templatePath, 'utf8');
        const template = handlebars.compile(templateHtml);
        const html = template(templateData);

        // Use the provided browser from the pool
        const page = await browser.newPage();
        await page.setContent(html, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '15px', bottom: '15px', left: '15px', right: '15px' },
            preferCSSPageSize: true
        });

        await page.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="INVOICE_${invoice.invoice_no}.pdf"`);
        res.setHeader('Content-Length', pdf.length);
        res.send(pdf);

    } catch (error) {
        console.error('Invoice PDF generation error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: 'Failed to generate invoice PDF: ' + error.message
            });
        }
    } finally {
        if (conn) await conn.end();
    }
}


// Cost of Sales Endpoint
app.get('/api/cost-of-sales', async (req, res) => {
    let conn;
    try {
        const { startDate, endDate } = req.query;
        conn = await getDbConnection();

        // Only show finalized invoices (invoiceFinalized = true means status = 'sent')
        let queryStr = `
            SELECT 
                i.id as invoice_id,
                i.invoice_no,
                i.total,
                i.created_at,
                jc.job_no,
                c.name as customer_name,
                s.name as shipper_name
            FROM invoices i
            LEFT JOIN job_cards jc ON i.job_card_id = jc.id
            LEFT JOIN customers c ON jc.customer_id = c.id
            LEFT JOIN shippers s ON jc.shipper_id = s.id
            WHERE i.status = 'sent'
        `;
        const params = [];
        if (startDate) {
            queryStr += ` AND DATE(i.created_at) >= ?`;
            params.push(startDate);
        }
        if (endDate) {
            queryStr += ` AND DATE(i.created_at) <= ?`;
            params.push(endDate);
        }
        queryStr += ` ORDER BY i.created_at DESC`;

        const invoices = await conn.query(queryStr, params);

        // Fetch only REQUIRED charges (not marginal) for cost of sales
        const invoiceIds = invoices.map(inv => inv.invoice_id);

        let allItems = [];
        if (invoiceIds.length > 0) {
            allItems = await conn.query(`
                SELECT invoice_id, description, amount
                FROM invoice_items
                WHERE invoice_id IN (?)
                AND (charge_type = 'required' OR charge_type IS NULL)
            `, [invoiceIds]);
        }

        // Group charges by invoice_id
        const itemsByInvoice = {};
        allItems.forEach(item => {
            if (!itemsByInvoice[item.invoice_id]) {
                itemsByInvoice[item.invoice_id] = [];
            }
            itemsByInvoice[item.invoice_id].push(item);
        });

        // Map charges into invoices
        const result = invoices.map(inv => {
            const chargesList = itemsByInvoice[inv.invoice_id] || [];

            // Format dynamic charges into an object mapping description -> amount
            const charges = {};
            let requiredTotal = 0;
            chargesList.forEach(charge => {
                if (charge.description) {
                    charges[charge.description] = parseFloat(charge.amount) || 0;
                    requiredTotal += parseFloat(charge.amount) || 0;
                }
            });

            return {
                invoice_id:    inv.invoice_id,
                invoice_no:    inv.invoice_no,
                job_no:        inv.job_no,
                customer_name: inv.customer_name,
                shipper_name:  inv.shipper_name,
                total:         requiredTotal,   // required charges only
                created_at:    inv.created_at,
                charges:       charges
            };
        });

        res.json({
            success: true,
            data: result
        });

    } catch (error) {
        console.error('Error fetching cost of sales:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch cost of sales data', error: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// Email Cost of Sales Report directly to Admin Email (from .env) with .xlsx Attachment
app.post('/api/cost-of-sales/send-email', async (req, res) => {
    try {
        const { excelBase64, customMessage } = req.body;
        const adminEmail = (process.env.ADMIN_EMAIL || 'mkaifsurve@yahoo.com').trim();
        const todayDate = new Date().toISOString().split('T')[0];

        const subject = `Cost of Sales Summary Report (${todayDate})`;
        const htmlContent = `
            <div style="font-family: Arial, sans-serif; color: #1e293b; line-height: 1.6; max-width: 650px; border: 1px solid #e2e8f0; padding: 24px; border-radius: 8px; background-color: #ffffff;">
                <h2 style="color: #1e3a8a; margin-top: 0; border-bottom: 2px solid #2563eb; padding-bottom: 8px; font-size: 20px;">Al Eid International Logistic Company</h2>
                <h3 style="color: #334155; font-size: 16px; margin-top: 16px;">Cost of Sales Summary Report (${todayDate})</h3>
                <p style="margin-top: 16px;">Hello Admin,</p>
                <p>Please find attached the official <strong>Cost of Sales Excel (.xlsx)</strong> sheet report generated on <strong>${todayDate}</strong>.</p>
                ${customMessage ? `<p style="background: #f8fafc; padding: 12px; border-left: 4px solid #2563eb; border-radius: 4px; font-size: 14px; color: #334155;"><strong>Note:</strong> ${customMessage}</p>` : ''}
                <hr style="border: none; border-top: 1px solid #e2e8f0; margin-top: 24px; margin-bottom: 16px;">
                <p style="font-size: 12px; color: #64748b; margin: 0;">This is an automated system notification sent from Al Eid POS Backend System.</p>
            </div>
        `;

        const attachments = [];
        if (excelBase64) {
            attachments.push({
                filename: `Cost_of_Sales_${todayDate}.xlsx`,
                content: Buffer.from(excelBase64, 'base64'),
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            });
        }

        await sendEmail(adminEmail, subject, `Cost of Sales Report - ${todayDate}`, htmlContent, attachments);
        res.json({ success: true, message: `Cost of Sales Excel report emailed successfully to ${adminEmail}`, adminEmail });
    } catch (error) {
        console.error('Error sending Cost of Sales email to admin:', error);
        res.status(500).json({ success: false, message: 'Failed to send email to admin', error: error.message });
    }
});

// ==================== SALES REPORT ENDPOINT (ALL CHARGES — REQUIRED + MARGINAL) ====================
app.get('/api/sales-report', async (req, res) => {
    let conn;
    try {
        const { startDate, endDate } = req.query;
        conn = await getDbConnection();

        // Only finalized invoices (status = sent)
        let queryStr = `
            SELECT
                i.id        AS invoice_id,
                i.invoice_no,
                i.total,
                i.created_at,
                jc.job_no,
                jc.cost_center,
                jc.cost_center_number,
                jc.driver_name,
                c.name      AS customer_name,
                s.name      AS shipper_name,
                a.name      AS agent_name,
                rp.name     AS responsible_person
            FROM invoices i
            LEFT JOIN job_cards jc    ON i.job_card_id            = jc.id
            LEFT JOIN customers c     ON jc.customer_id           = c.id
            LEFT JOIN shippers  s     ON jc.shipper_id            = s.id
            LEFT JOIN agents    a     ON jc.agent_id              = a.id
            LEFT JOIN responsible_persons rp ON jc.responsible_person_id = rp.id
            WHERE i.status = 'sent'
        `;
        const params = [];
        if (startDate) { queryStr += ` AND DATE(i.created_at) >= ?`; params.push(startDate); }
        if (endDate)   { queryStr += ` AND DATE(i.created_at) <= ?`; params.push(endDate); }
        queryStr += ` ORDER BY i.created_at DESC`;

        const invoices = await conn.query(queryStr, params);

        // Fetch ALL charges (required + marginal)
        const invoiceIds = invoices.map(inv => inv.invoice_id);
        let allItems = [];
        if (invoiceIds.length > 0) {
            allItems = await conn.query(
                `SELECT invoice_id, description, charge_type, amount FROM invoice_items WHERE invoice_id IN (?)`,
                [invoiceIds]
            );
        }

        // Group charges by invoice_id
        const itemsByInvoice = {};
        allItems.forEach(item => {
            if (!itemsByInvoice[item.invoice_id]) itemsByInvoice[item.invoice_id] = [];
            itemsByInvoice[item.invoice_id].push(item);
        });

        const result = invoices.map(inv => {
            const chargesList = itemsByInvoice[inv.invoice_id] || [];
            const charges = {};
            const chargeTypes = {}; // track required/marginal per description
            chargesList.forEach(ch => {
                if (ch.description) {
                    charges[ch.description] = parseFloat(ch.amount) || 0;
                    chargeTypes[ch.description] = ch.charge_type || 'required';
                }
            });
            return {
                invoice_id:         inv.invoice_id,
                invoice_no:         inv.invoice_no,
                job_no:             inv.job_no,
                customer_name:      inv.customer_name,
                shipper_name:       inv.shipper_name,
                agent_name:         inv.agent_name,
                driver_name:        inv.driver_name,
                responsible_person: inv.responsible_person,
                cost_center:        inv.cost_center,
                cost_center_number: inv.cost_center_number,
                total:              parseFloat(inv.total) || 0,
                created_at:         inv.created_at,
                charges,
                chargeTypes
            };
        });

        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Sales report error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch sales report', error: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// Email Sales Report to Admin
app.post('/api/sales-report/send-email', async (req, res) => {
    try {
        const { excelBase64, customMessage } = req.body;
        const adminEmail = (process.env.ADMIN_EMAIL || 'mkaifsurve@yahoo.com').trim();
        const todayDate = new Date().toISOString().split('T')[0];

        const subject = `Sales Report — All Charges (${todayDate})`;
        const htmlContent = `
            <div style="font-family:Arial,sans-serif;color:#1e293b;line-height:1.6;max-width:650px;border:1px solid #e2e8f0;padding:24px;border-radius:8px;background:#fff;">
                <h2 style="color:#1e3a8a;margin-top:0;border-bottom:2px solid #2563eb;padding-bottom:8px;font-size:20px;">Al Eid International Logistic Company</h2>
                <h3 style="color:#334155;font-size:16px;margin-top:16px;">Sales Report — Required & Marginal Charges (${todayDate})</h3>
                <p>Hello Admin,</p>
                <p>Please find attached the <strong>Sales Report Excel (.xlsx)</strong> generated on <strong>${todayDate}</strong>.</p>
                ${customMessage ? `<p style="background:#f8fafc;padding:12px;border-left:4px solid #2563eb;border-radius:4px;font-size:14px;color:#334155;"><strong>Note:</strong> ${customMessage}</p>` : ''}
                <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 16px;">
                <p style="font-size:12px;color:#64748b;margin:0;">Automated notification — Al Eid POS Backend.</p>
            </div>
        `;

        const attachments = [];
        if (excelBase64) {
            attachments.push({
                filename: `Sales_Report_${todayDate}.xlsx`,
                content: Buffer.from(excelBase64, 'base64'),
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            });
        }

        await sendEmail(adminEmail, subject, `Sales Report - ${todayDate}`, htmlContent, attachments);
        res.json({ success: true, message: `Sales Report emailed to ${adminEmail}`, adminEmail });
    } catch (error) {
        console.error('Sales report email error:', error);
        res.status(500).json({ success: false, message: 'Failed to send email', error: error.message });
    }
});

// Customer Details & Analytics Endpoint
app.get('/api/customer-details', async (req, res) => {
    let conn;
    try {
        const { customerId } = req.query;
        conn = await getDbConnection();

        // 1. Get all customers for selector dropdown
        const customersList = await conn.query(`SELECT id, name, company, email, phone FROM customers ORDER BY name ASC`);

        // 2. Fetch invoices joined with job_cards, customers, and shippers
        // No status filter — all invoices are real invoices (no proforma workflow)
        let sql = `
            SELECT 
                i.id as invoice_id,
                i.invoice_no,
                i.total,
                i.created_at as invoice_date,
                jc.id as job_card_id,
                jc.job_no,
                c.id as customer_id,
                c.name as customer_name,
                c.company as customer_company,
                s.name as shipper_name
            FROM invoices i
            JOIN job_cards jc ON i.job_card_id = jc.id
            JOIN customers c ON jc.customer_id = c.id
            LEFT JOIN shippers s ON jc.shipper_id = s.id
            WHERE i.status = 'sent'
        `;
        const params = [];
        if (customerId) {
            sql += ` AND c.id = ?`;
            params.push(customerId);
        }
        sql += ` ORDER BY i.created_at DESC`;

        const invoices = await conn.query(sql, params);

        // 3. Overall Sales Sum — all invoices
        const totalSalesResult = await conn.query(`SELECT SUM(total) as grand_total FROM invoices WHERE status = 'sent'`);
        const grandTotalSales = parseFloat(totalSalesResult[0]?.grand_total) || 0;

        // 4. Customer share summary for pie chart
        const customerShareSummary = await conn.query(`
            SELECT 
                c.id as customer_id,
                c.name as customer_name,
                SUM(i.total) as total_spent,
                COUNT(i.id) as invoice_count
            FROM invoices i
            JOIN job_cards jc ON i.job_card_id = jc.id
            JOIN customers c ON jc.customer_id = c.id
            WHERE i.status = 'sent'
            GROUP BY c.id, c.name
            ORDER BY total_spent DESC
        `);

        // 5. Monthly trend analysis
        let trendSql = `
            SELECT 
                DATE_FORMAT(i.created_at, '%Y-%m') as month,
                SUM(i.total) as monthly_total,
                COUNT(i.id) as invoice_count
            FROM invoices i
            JOIN job_cards jc ON i.job_card_id = jc.id
            WHERE i.status = 'sent'
        `;
        const trendParams = [];
        if (customerId) {
            trendSql += ` AND jc.customer_id = ?`;
            trendParams.push(customerId);
        }
        trendSql += ` GROUP BY DATE_FORMAT(i.created_at, '%Y-%m') ORDER BY month ASC`;

        const monthlyTrend = await conn.query(trendSql, trendParams);

        // 6. Exact Daily Order Timeline Trend (Line Chart)
        let dailySql = `
            SELECT 
                DATE_FORMAT(i.created_at, '%Y-%m-%d') as order_date,
                SUM(i.total) as daily_total,
                COUNT(i.id) as order_count
            FROM invoices i
            JOIN job_cards jc ON i.job_card_id = jc.id
            WHERE i.status = 'sent'
        `;
        const dailyParams = [];
        if (customerId) {
            dailySql += ` AND jc.customer_id = ?`;
            dailyParams.push(customerId);
        }
        dailySql += ` GROUP BY DATE_FORMAT(i.created_at, '%Y-%m-%d') ORDER BY order_date ASC LIMIT 30`;

        const dailyTrend = await conn.query(dailySql, dailyParams);

        // 7. Top Charge Services Expense Breakdown — both required AND marginal
        let chargeSql = `
            SELECT 
                ii.description as charge_name,
                SUM(ii.amount) as total_amount,
                COUNT(ii.id) as item_count
            FROM invoice_items ii
            JOIN invoices i ON ii.invoice_id = i.id
            JOIN job_cards jc ON i.job_card_id = jc.id
            WHERE i.status = 'sent'
        `;
        const chargeParams = [];
        if (customerId) {
            chargeSql += ` AND jc.customer_id = ?`;
            chargeParams.push(customerId);
        }
        chargeSql += ` GROUP BY ii.description HAVING total_amount > 0 ORDER BY total_amount DESC LIMIT 8`;

        const chargeBreakdown = await conn.query(chargeSql, chargeParams);

        res.json({
            success: true,
            grandTotalSales,
            customersList,
            customerShareSummary: customerShareSummary.map(cs => ({
                ...cs,
                total_spent: parseFloat(cs.total_spent) || 0,
                percentage_share: grandTotalSales > 0 ? ((parseFloat(cs.total_spent) / grandTotalSales) * 100).toFixed(2) : 0
            })),
            monthlyTrend: monthlyTrend.map(mt => ({
                ...mt,
                monthly_total: parseFloat(mt.monthly_total) || 0
            })),
            dailyTrend: dailyTrend.map(dt => ({
                ...dt,
                daily_total: parseFloat(dt.daily_total) || 0
            })),
            chargeBreakdown: chargeBreakdown.map(cb => ({
                ...cb,
                total_amount: parseFloat(cb.total_amount) || 0
            })),
            invoices: invoices.map(inv => ({
                ...inv,
                total: parseFloat(inv.total) || 0
            }))
        });

    } catch (error) {
        console.error('Error fetching customer details:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch customer details', error: error.message });
    } finally {
        if (conn) await conn.end();
    }
});


// ==================== PROFORMA / DRAFT INVOICE API ENDPOINTS (NEW TABLE) ====================

// 1. Get all proforma (draft) invoices for queue history table
app.get('/api/proforma-invoices', async (req, res) => {
    let conn;
    try {
        const { jobCardId } = req.query;
        conn = await getDbConnection();
        let query = `
            SELECT id as invoice_id, proforma_no as invoice_no, job_card_id, job_no, customer_name, total, created_by, created_at, notes, 'draft' as status
            FROM proforma_invoices
        `;
        let params = [];
        if (jobCardId) {
            query += ` WHERE job_card_id = ?`;
            params.push(jobCardId);
        }
        query += ` ORDER BY created_at DESC`;

        const drafts = await conn.query(query, params);
        res.json({ success: true, data: drafts });
    } catch (error) {
        console.error('Error fetching proforma invoices:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch proforma invoices', error: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// 2. Get single proforma invoice with items for editing (CRUD Edit)
app.get('/api/proforma-invoices/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        conn = await getDbConnection();
        const drafts = await conn.query(`
            SELECT 
                p.id as invoice_id, p.proforma_no as invoice_no, p.total, p.subtotal, p.items_json, p.advance_payment_json, p.notes, p.created_at, p.job_card_id, p.job_no,
                jc.atd as estd,
                jc.ata as eta,
                jc.pol as departure_location,
                jc.pod as arrival_location,
                jc.cost_center,
                jc.cost_center_number,
                jc.commercial_invoice_no,
                jc.requestor_name as requester_name,
                c.name as customer_name, c.address as customer_address,
                c.email as email,
                c.phone as phone,
                jc.vehicle_number as truck_waybill_no,
                s.name as shipper_name,
                jc.shipper_ref_no,
                jc.declaration_number as bayan_no,
                jc.bayan_date,
                jc.gross_weight,
                jc.no_of_packages as packages
            FROM proforma_invoices p
            LEFT JOIN job_cards jc ON p.job_card_id = jc.id
            LEFT JOIN customers c ON jc.customer_id = c.id
            LEFT JOIN shippers s ON jc.shipper_id = s.id
            WHERE p.id = ?
        `, [id]);

        if (drafts.length === 0) {
            return res.status(404).json({ success: false, message: 'Proforma draft invoice not found' });
        }

        const draft = drafts[0];
        let items = [];
        let advancePayment = null;
        try {
            if (draft.items_json) items = typeof draft.items_json === 'string' ? JSON.parse(draft.items_json) : draft.items_json;
            if (draft.advance_payment_json) advancePayment = typeof draft.advance_payment_json === 'string' ? JSON.parse(draft.advance_payment_json) : draft.advance_payment_json;
        } catch (e) {
            console.error('JSON parsing error:', e);
        }

        res.json({
            success: true,
            invoice: draft,
            items: items,
            advancePayment: advancePayment
        });
    } catch (error) {
        console.error('Error fetching proforma draft invoice:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch proforma draft', error: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// 3. Save or Update Proforma Draft Invoice (CRUD Create / Update)
app.post('/api/proforma-invoices', async (req, res) => {
    let conn;
    try {
        const { invoiceId, jobCardId, createdBy, notes, items, advancePayment, discount } = req.body;
        if (!jobCardId) {
            return res.status(400).json({ success: false, message: 'Job Card ID is required to save a draft.' });
        }

        conn = await getDbConnection();

        // Fetch job card details
        const jcInfo = await conn.query(`SELECT job_no, customer_id, (SELECT name FROM customers WHERE id = job_cards.customer_id) as customer_name FROM job_cards WHERE id = ?`, [jobCardId]);
        let jobNo = '', customerId = null, customerName = '';
        if (jcInfo.length > 0) {
            jobNo = jcInfo[0].job_no;
            customerId = jcInfo[0].customer_id;
            customerName = jcInfo[0].customer_name;
        }

        let total = 0;
        let subtotal = 0;
        if (items && Array.isArray(items)) {
            items.forEach(it => {
                const amt = parseFloat(it.amount) || (parseFloat(it.quantity) * parseFloat(it.unit_price));
                total += amt;
                subtotal += amt;
            });
        }

        // Apply discount if present
        const discountAmount = parseFloat(discount?.amount) || 0;
        const discountReason = discount?.reason || discount?.reason_text || '';
        const finalTotal = Math.max(total - discountAmount, 0);

        const itemsJson = JSON.stringify(items || []);
        const advJson = JSON.stringify(advancePayment || null);
        let targetInvoiceId = invoiceId;

        if (targetInvoiceId) {
            await conn.query(`
                UPDATE proforma_invoices 
                SET items_json = ?, advance_payment_json = ?, total = ?, subtotal = ?, 
                    discount_amount = ?, discount_reason = ?,
                    notes = ?, updated_at = NOW()
                WHERE id = ?
            `, [itemsJson, advJson, finalTotal, subtotal, discountAmount, discountReason, notes || '', targetInvoiceId]);
        } else {
            targetInvoiceId = require('crypto').randomUUID ? require('crypto').randomUUID() : `draft_${Date.now()}`;
            const proformaNo = `PROF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
            await conn.query(`
                INSERT INTO proforma_invoices (
                    id, proforma_no, job_card_id, job_no, customer_id, customer_name, 
                    total, subtotal, discount_amount, discount_reason,
                    items_json, advance_payment_json, notes, created_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [targetInvoiceId, proformaNo, jobCardId, jobNo, customerId, customerName, 
                finalTotal, subtotal, discountAmount, discountReason,
                itemsJson, advJson, notes || '', createdBy || 'system']);
        }

        res.json({
            success: true,
            message: 'Proforma draft invoice saved successfully',
            invoiceId: targetInvoiceId
        });
    } catch (error) {
        console.error('Error saving proforma draft invoice:', error);
        res.status(500).json({ success: false, message: 'Failed to save proforma draft invoice', error: error.message });
    } finally {
        if (conn) await conn.end();
    }
});



// 4. Delete Proforma Draft Invoice (CRUD Delete)
app.delete('/api/proforma-invoices/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        conn = await getDbConnection();
        await conn.query(`DELETE FROM proforma_invoices WHERE id = ?`, [id]);
        res.json({ success: true, message: 'Proforma draft invoice deleted successfully' });
    } catch (error) {
        console.error('Error deleting proforma draft invoice:', error);
        res.status(500).json({ success: false, message: 'Failed to delete proforma draft', error: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// Replace the existing proforma PDF endpoint with this queue-based version
app.get('/api/proforma-invoices/:id/pdf', async (req, res) => {
    const { id } = req.params;
    // Queue the PDF request instead of generating immediately
    queuePDFRequest(id, res, 'proforma');
});

// Rename your current proforma PDF generation function to generateProformaPDF
async function generateProformaPDF(id, res, browser) {
    let conn;
    try {
        conn = await getDbConnection();

        const drafts = await conn.query(`
            SELECT 
                p.id as invoice_id,
                p.proforma_no as invoice_no,
                p.total,
                p.subtotal,
                p.discount_amount,
                p.discount_reason,
                p.items_json,
                p.advance_payment_json,
                p.notes,
                p.created_at,
                p.job_card_id,
                p.job_no,
                jc.atd as estd,
                jc.ata as eta,
                jc.pol as departure_location,
                jc.pod as arrival_location,
                jc.cost_center,
                jc.cost_center_number,
                jc.commercial_invoice_no,
                jc.requestor_name as requester_name,
                jc.hawb,
                jc.mawb,
                jc.vehicle_number as truck_waybill_no,
                jc.shipper_ref_no,
                jc.declaration_number as bayan_no,
                jc.bayan_date,
                jc.gross_weight,
                jc.no_of_packages as packages,
                jc.packages_unit as package_type,
                c.name as customer_name,
                c.address as customer_address,
                c.email as customer_email,
                c.phone as customer_phone,
                c.reference_number as customer_ref_no,
                s.name as shipper_name,
                s.reference_number as shipper_ref_no_joined,
                jc.job_no as jc_job_no
            FROM proforma_invoices p
            LEFT JOIN job_cards jc ON p.job_card_id = jc.id
            LEFT JOIN customers c ON jc.customer_id = c.id
            LEFT JOIN shippers s ON jc.shipper_id = s.id
            WHERE p.id = ?
        `, [id]);

        if (drafts.length === 0) {
            return res.status(404).json({ success: false, message: 'Proforma draft not found' });
        }

        const draft = drafts[0];

        // Get billing doc extra columns
        let hbl = '', mbl = '', habw = '', mabw = '', road_waybill = '', multimodal_ref = '';
        try {
            const extra = await conn.query(
                `SELECT hawb, mawb, habw, mabw, hbl, mbl, road_waybill, multimodal_ref, truck_waybill_no 
                 FROM job_cards WHERE id = ? LIMIT 1`,
                [draft.job_card_id]
            );
            if (extra.length > 0) {
                const e = extra[0];
                hbl = e.hbl || e.hawb || '';
                mbl = e.mbl || e.mawb || '';
                habw = e.habw || e.hawb || '';
                mabw = e.mabw || e.mawb || '';
                road_waybill = e.road_waybill || e.truck_waybill_no || '';
                multimodal_ref = e.multimodal_ref || '';
            }
        } catch (_) {}

        // Parse items and advance payment
        let allCharges = [];
        try {
            allCharges = draft.items_json
                ? (typeof draft.items_json === 'string' ? JSON.parse(draft.items_json) : draft.items_json)
                : [];
        } catch (e) {}

        // Sort: Marginal first, then required
        allCharges.sort((a, b) => {
            const aIsMarginal = (a.charge_type === 'marginal' || a.type === 'marginal');
            const bIsMarginal = (b.charge_type === 'marginal' || b.type === 'marginal');
            if (aIsMarginal && !bIsMarginal) return -1;
            if (!aIsMarginal && bIsMarginal) return 1;
            return (a.description || '').localeCompare(b.description || '');
        });

        // Paginate: Max 20 charges per page
        const MAX_CHARGES_PER_PAGE = 20;
        const chargePages = [];
        for (let i = 0; i < allCharges.length; i += MAX_CHARGES_PER_PAGE) {
            chargePages.push(allCharges.slice(i, i + MAX_CHARGES_PER_PAGE));
        }

        let advPayment = null;
        try {
            advPayment = draft.advance_payment_json
                ? (typeof draft.advance_payment_json === 'string' ? JSON.parse(draft.advance_payment_json) : draft.advance_payment_json)
                : null;
        } catch (e) {}

        const advanceAmt = parseFloat(advPayment?.amount) || 0;
        const totalCharges = allCharges.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
        
        const discountAmount = parseFloat(draft.discount_amount) || 0;
        const discountReason = draft.discount_reason || '';
        const netTotal = totalCharges - discountAmount;
        
        const balanceDue = Math.max(netTotal - advanceAmt, 0);
        const credits = Math.max(advanceAmt - netTotal, 0);

        const jobNo = draft.job_no || draft.jc_job_no || '';
        const is_sea = jobNo.startsWith('SEA');
        const is_air = jobNo.startsWith('AIR');

        const fmt = (d) => {
            if (!d) return '';
            try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } 
            catch (e) { return String(d); }
        };

        // Load logo
        let logoBase64 = '';
        try {
            const logoPaths = [
                path.join(__dirname, 'logo.svg'),
                path.join(__dirname, '..', 'logo.svg'),
                path.join(__dirname, 'logo.png'),
                path.join(__dirname, '..', 'logo.png'),
                path.join(__dirname, 'logo.jpg'),
                path.join(__dirname, '..', 'logo.jpg'),
                path.join(__dirname, '..', '..', 'logo.svg'),
                path.join(__dirname, '..', '..', 'logo.png')
            ];

            for (const logoPath of logoPaths) {
                if (fs.existsSync(logoPath)) {
                    const ext = path.extname(logoPath).toLowerCase();
                    let mimeType = 'image/svg+xml';
                    if (ext === '.png') mimeType = 'image/png';
                    else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                    
                    const data = fs.readFileSync(logoPath);
                    logoBase64 = `data:${mimeType};base64,` + data.toString('base64');
                    console.log(`✅ Logo loaded from: ${logoPath}`);
                    break;
                }
            }
            
            if (!logoBase64) {
                console.log('⚠️ Logo not found in any of the expected paths');
            }
        } catch (err) {
            console.log('⚠️ Logo loading error:', err.message);
        }

        const templateData = {
            is_proforma: true,
            is_sea,
            is_air,
            logo: logoBase64,
            company_phone: '24311005',
            company_email: 'sales@aleidlogistics.com',
            customer_name: draft.customer_name || '--',
            customer_address: draft.customer_address || '',
            shipper_name: draft.shipper_name || '--',
            shipper_ref_no: draft.shipper_ref_no || draft.shipper_ref_no_joined || '--',
            departure_location: draft.departure_location || '--',
            bayan_no: draft.bayan_no || '--',
            bayan_date: fmt(draft.bayan_date),
            gross_weight: draft.gross_weight || '0.000',
            customer_ref_no: draft.customer_ref_no || '--',
            packages: draft.packages || '0',
            package_type: draft.package_type || 'pcs',
            invoice_no: draft.invoice_no || '--',
            invoice_date: fmt(draft.created_at),
            job_no: draft.job_no || jobNo || '--',
            truck_waybill_no: draft.truck_waybill_no || draft.hawb || draft.mawb || '--',
            commercial_invoice_no: draft.commercial_invoice_no || '--',
            etd: fmt(draft.estd),
            eta: fmt(draft.eta),
            arrival_location: draft.arrival_location || '--',
            cost_center_number: draft.cost_center_number || draft.cost_center || '--',
            customer_email: draft.customer_email || '--',
            requester_name: draft.requester_name || '--',
            hbl,
            mbl,
            habw,
            mabw,
            road_waybill: road_waybill || draft.truck_waybill_no || '--',
            multimodal_ref,
            all_charges: allCharges.map(it => ({
                description: it.description || '',
                charge_type: it.charge_type || it.type || 'required',
                quantity: parseFloat(it.quantity) || 0,
                unit: it.unit || 'nos',
                rate: parseFloat(it.rate || it.unit_price) || 0,
                amount: parseFloat(it.amount) || 0
            })),
            chargePages: chargePages.map(page => 
                page.map(it => ({
                    description: it.description || '',
                    charge_type: it.charge_type || it.type || 'required',
                    quantity: parseFloat(it.quantity) || 0,
                    unit: it.unit || 'nos',
                    rate: parseFloat(it.rate || it.unit_price) || 0,
                    amount: parseFloat(it.amount) || 0
                }))
            ),
            totalPages: chargePages.length,
            total_charges: totalCharges,
            discount_amount: discountAmount,
            discount_reason: discountReason,
            net_total: netTotal,
            advance_payment: advanceAmt,
            credits_balance: credits,
            balance_due: balanceDue,
            amount_in_words: amountToKwdWords(netTotal),
            advancePayments: advanceAmt > 0 ? [{
                amount: advanceAmt,
                payment_method: advPayment?.method || 'cash',
                reference_number: advPayment?.reference || '',
                payment_date: fmt(advPayment?.date)
            }] : []
        };

        const templatePath = path.join(__dirname, 'invoice-template.hbs');
        const templateHtml = await fs.promises.readFile(templatePath, 'utf8');
        const template = handlebars.compile(templateHtml);
        const html = template(templateData);

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '15px', bottom: '15px', left: '15px', right: '15px' },
            preferCSSPageSize: true
        });
        await page.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="PROFORMA_${draft.invoice_no}.pdf"`);
        res.setHeader('Content-Length', pdf.length);
        res.send(pdf);

    } catch (error) {
        console.error('Proforma PDF error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate Proforma PDF', error: error.message });
    } finally {
        if (conn) await conn.end();
    }
}





// Alias for older frontend versions
app.get('/api/invoices/:id/proforma-pdf', async (req, res) => {
    const { id } = req.params;
    queuePDFRequest(id, res, 'proforma');
});

// ==================== CHARGES WIZARD API ====================

// GET /api/wizard/:jobId
// Returns: job card info, invoice_finalized flag, existing official invoice charges, proforma queue
app.get('/api/wizard/:jobId', async (req, res) => {
    let conn;
    try {
        const { jobId } = req.params;
        conn = await getDbConnection();

        // 1. Load full job card with joined names
        const jcRows = await conn.query(`
            SELECT
                jc.id, jc.job_no, jc.invoice_no, jc.operation_date,
                jc.hawb, jc.mawb,
                jc.pol, jc.pod, jc.status, jc.created_by,
                jc.gross_weight, jc.no_of_packages, jc.packages_unit,
                c.name  AS customer_name,
                s.name  AS shipper_name,
                con.name AS consignee_name,
                a.name  AS agent_name,
                rp.name AS responsible_person_name
            FROM job_cards jc
            LEFT JOIN customers    c   ON jc.customer_id            = c.id
            LEFT JOIN shippers     s   ON jc.shipper_id             = s.id
            LEFT JOIN consignees   con ON jc.consignee_id           = con.id
            LEFT JOIN agents       a   ON jc.agent_id               = a.id
            LEFT JOIN responsible_persons rp ON jc.responsible_person_id = rp.id
            WHERE jc.id = ? OR jc.job_no = ?
            LIMIT 1
        `, [jobId, jobId]);

        // Try to get billing doc columns separately
        let hblHawbExtra = '--';
        try {
            const extraCols = await conn.query(
                `SELECT habw, mabw, hbl, mbl, road_waybill FROM job_cards WHERE id = ? OR job_no = ? LIMIT 1`,
                [jobId, jobId]
            );
            if (extraCols.length > 0) {
                const e = extraCols[0];
                hblHawbExtra = e.habw || e.hbl || e.mabw || e.mbl || e.road_waybill || '--';
            }
        } catch (_) { /* columns not yet migrated — ignore */ }

        if (jcRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Job card not found' });
        }

        const jc = jcRows[0];
        const hblHawb = jc.hawb || jc.mawb || hblHawbExtra || '--';

        // 3. Check if official invoice already exists and is finalized
        let invoiceFinalized = false;
        let officialInvoice = null;
        let officialCharges = [];
        let officialAdvancePayments = [];

        if (jc.invoice_no && !jc.invoice_no.startsWith('PROF-')) {
            const invRows = await conn.query(
                `SELECT id, invoice_no, subtotal, tax, total, discount_amount, discount_reason, status, notes, created_at
                 FROM invoices WHERE job_card_id = ? ORDER BY created_at DESC LIMIT 1`,
                [jc.id]
            );

            if (invRows.length > 0) {
                const inv = invRows[0];
                if (inv.status && inv.status !== 'draft') {
                    invoiceFinalized = true;
                    officialInvoice = {
                        ...inv,
                        discount_amount: parseFloat(inv.discount_amount) || 0,
                        discount_reason: inv.discount_reason || ''
                    };

                    // Load charges
                    officialCharges = await conn.query(
                        `SELECT description, charge_type, quantity, unit, rate, amount
                         FROM invoice_items WHERE invoice_id = ? ORDER BY id`,
                        [inv.id]
                    );

                    // Load advance payments
                    officialAdvancePayments = await conn.query(
                        `SELECT amount, payment_date, payment_method, reference_number, notes
                         FROM advance_payments WHERE invoice_id = ? ORDER BY created_at`,
                        [inv.id]
                    );
                }
            }
        }

        // 4. Load proforma queue with discount data
        const proformaQueue = await conn.query(`
            SELECT id, proforma_no, total, subtotal, discount_amount, discount_reason,
                   notes, created_by, created_at, updated_at
            FROM proforma_invoices
            WHERE job_card_id = ?
            ORDER BY created_at DESC
        `, [jc.id]);

        // 5. Load charge type options
        const chargeTypes = await conn.query(
            `SELECT id, charge_name AS name FROM description_charges WHERE is_active = TRUE ORDER BY charge_name`
        );

        res.json({
            success: true,
            jobCard: {
                id: jc.id,
                job_no: jc.job_no,
                invoice_no: jc.invoice_no || '',
                hbl_hawb: hblHawb,
                pol: jc.pol || '--',
                pod: jc.pod || '--',
                status: jc.status || 'draft',
                created_by: jc.created_by || 'system',
                customer_name: jc.customer_name || '--',
                shipper_name: jc.shipper_name || '--',
                consignee_name: jc.consignee_name || '--',
                agent_name: jc.agent_name || '--',
                responsible_person: jc.responsible_person_name || '--',
                gross_weight: parseFloat(jc.gross_weight) || 0,
                no_of_packages: jc.no_of_packages || 0,
                packages_unit: jc.packages_unit || 'pcs'
            },
            invoiceFinalized,
            officialInvoice: officialInvoice ? {
                ...officialInvoice,
                subtotal: parseFloat(officialInvoice.subtotal) || 0,
                tax: parseFloat(officialInvoice.tax) || 0,
                total: parseFloat(officialInvoice.total) || 0,
                discount_amount: parseFloat(officialInvoice.discount_amount) || 0,
                discount_reason: officialInvoice.discount_reason || ''
            } : null,
            officialCharges: officialCharges.map(c => ({
                ...c,
                quantity: parseFloat(c.quantity) || 0,
                rate: parseFloat(c.rate) || 0,
                amount: parseFloat(c.amount) || 0
            })),
            officialAdvancePayments: officialAdvancePayments.map(p => ({
                ...p,
                amount: parseFloat(p.amount) || 0
            })),
            proformaQueue: proformaQueue.map(p => ({
                ...p,
                total: parseFloat(p.total) || 0,
                subtotal: parseFloat(p.subtotal) || 0,
                discount_amount: parseFloat(p.discount_amount) || 0,
                discount_reason: p.discount_reason || ''
            })),
            chargeTypes
        });

    } catch (error) {
        console.error('Wizard load error:', error);
        res.status(500).json({ success: false, message: 'Failed to load wizard data: ' + error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// ==================== TRANSPORTERS ENDPOINTS ====================

// GET all transporters
app.get('/api/transporters', async (req, res) => {
    let conn;
    try {
        const { search = '', limit = 100 } = req.query;
        
        conn = await getDbConnection();
        
        let query = `
            SELECT id, name, code, phone, email, address, country, 
                   contact_person, is_active, created_at, updated_at
            FROM transporters 
            WHERE 1=1
        `;
        
        const params = [];
        
        if (search && search.length > 0) {
            query += ` AND (name LIKE ? OR code LIKE ? OR phone LIKE ? OR email LIKE ?)`;
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }
        
        query += ` ORDER BY name ASC LIMIT ?`;
        params.push(parseInt(limit));
        
        const transporters = await conn.query(query, params);
        
        res.json({
            success: true,
            data: transporters
        });
        
    } catch (error) {
        console.error('Get transporters error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get transporters: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// GET all transporters for dropdown (active only)
app.get('/api/transporters/all', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        
        const results = await conn.query(`
            SELECT id, name, code, phone, email
            FROM transporters 
            WHERE is_active = TRUE
            ORDER BY name ASC
        `);
        
        res.json({
            success: true,
            data: results
        });
        
    } catch (error) {
        console.error('Get transporters all error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get transporters: ' + error.message,
            data: []
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Search transporters for autocomplete
app.get('/api/transporters/search', async (req, res) => {
    let conn;
    try {
        const { q } = req.query;
        
        if (!q || q.length < 2) {
            return res.json([]);
        }
        
        conn = await getDbConnection();
        
        const results = await conn.query(`
            SELECT id, name, code, phone, email, contact_person
            FROM transporters 
            WHERE (name LIKE ? OR code LIKE ? OR phone LIKE ? OR contact_person LIKE ?)
            AND is_active = TRUE
            ORDER BY name
            LIMIT 15
        `, [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]);
        
        res.json(results);
        
    } catch (error) {
        console.error('Search transporters error:', error);
        res.status(500).json([]);
    } finally {
        if (conn) await conn.end();
    }
});

// GET single transporter by ID
app.get('/api/transporters/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        
        conn = await getDbConnection();
        
        const result = await conn.query(
            `SELECT id, name, code, phone, email, address, country, 
                    contact_person, is_active, created_at, updated_at
             FROM transporters WHERE id = ?`,
            [id]
        );
        
        if (result.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Transporter not found'
            });
        }
        
        res.json({
            success: true,
            data: result[0]
        });
        
    } catch (error) {
        console.error('Get transporter error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get transporter: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// CREATE new transporter
app.post('/api/transporters', async (req, res) => {
    let conn;
    try {
        const { name, code, phone, email, address, country, contact_person } = req.body;
        
        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Transporter name is required'
            });
        }
        
        conn = await getDbConnection();
        
        // Check if already exists
        const existing = await conn.query(
            'SELECT id FROM transporters WHERE LOWER(name) = LOWER(?)',
            [name.trim()]
        );
        
        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Transporter already exists with this name'
            });
        }
        
        const id = uuidv4();
        
        await conn.query(`
            INSERT INTO transporters (
                id, name, code, phone, email, address, country, 
                contact_person, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, NOW(), NOW())
        `, [id, name.trim(), code || null, phone || null, email || null, 
            address || null, country || null, contact_person || null]);
        
        const newRecord = await conn.query(
            'SELECT id, name, code, phone, email, contact_person FROM transporters WHERE id = ?',
            [id]
        );
        
        res.json({
            success: true,
            message: 'Transporter created successfully',
            data: newRecord[0]
        });
        
    } catch (error) {
        console.error('Create transporter error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create transporter: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// UPDATE transporter
app.put('/api/transporters/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { name, code, phone, email, address, country, contact_person, is_active } = req.body;
        
        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Transporter name is required'
            });
        }
        
        conn = await getDbConnection();
        
        const existing = await conn.query('SELECT id FROM transporters WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Transporter not found'
            });
        }
        
        // Check if another transporter has the same name
        const duplicateCheck = await conn.query(
            'SELECT id FROM transporters WHERE LOWER(name) = LOWER(?) AND id != ?',
            [name.trim(), id]
        );
        if (duplicateCheck.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Another transporter already exists with this name'
            });
        }
        
        await conn.query(`
            UPDATE transporters 
            SET name = ?, code = ?, phone = ?, email = ?, 
                address = ?, country = ?, contact_person = ?,
                is_active = ?, updated_at = NOW()
            WHERE id = ?
        `, [name.trim(), code || null, phone || null, email || null,
            address || null, country || null, contact_person || null,
            is_active !== undefined ? is_active : 1, id]);
        
        res.json({
            success: true,
            message: 'Transporter updated successfully'
        });
        
    } catch (error) {
        console.error('Update transporter error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update transporter: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// DELETE transporter (soft delete - deactivate)
app.delete('/api/transporters/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        
        conn = await getDbConnection();
        
        const existing = await conn.query('SELECT id, name FROM transporters WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Transporter not found'
            });
        }
        
        // Check if used in job cards
        const used = await conn.query(
            'SELECT COUNT(*) as count FROM job_cards WHERE transporter_id = ?',
            [id]
        );
        
        if (used[0]?.count > 0) {
            // Soft delete - just deactivate
            await conn.query(
                'UPDATE transporters SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
                [id]
            );
            return res.json({
                success: true,
                message: 'Transporter deactivated as it is in use',
                deactivated: true
            });
        }
        
        await conn.query('DELETE FROM transporters WHERE id = ?', [id]);
        
        res.json({
            success: true,
            message: 'Transporter deleted successfully'
        });
        
    } catch (error) {
        console.error('Delete transporter error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete transporter: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});


// GET /api/wizard/proforma/:proformaId  — load single proforma record with parsed items for edit
app.get('/api/wizard/proforma/:proformaId', async (req, res) => {
    let conn;
    try {
        const { proformaId } = req.params;
        conn = await getDbConnection();

        const rows = await conn.query(`
            SELECT id, proforma_no, job_card_id, total, subtotal, 
                   discount_amount, discount_reason,
                   items_json, advance_payment_json, notes, created_by, created_at, updated_at
             FROM proforma_invoices WHERE id = ?
        `, [proformaId]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Proforma not found' });
        }

        const p = rows[0];
        let items = [];
        let advancePayment = null;

        try { items = p.items_json ? (typeof p.items_json === 'string' ? JSON.parse(p.items_json) : p.items_json) : []; } catch(e) {}
        try { advancePayment = p.advance_payment_json ? (typeof p.advance_payment_json === 'string' ? JSON.parse(p.advance_payment_json) : p.advance_payment_json) : null; } catch(e) {}

        res.json({
            success: true,
            proforma: {
                id: p.id,
                proforma_no: p.proforma_no,
                job_card_id: p.job_card_id,
                total: parseFloat(p.total) || 0,
                subtotal: parseFloat(p.subtotal) || 0,
                discount_amount: parseFloat(p.discount_amount) || 0,
                discount_reason: p.discount_reason || '',
                notes: p.notes || '',
                created_by: p.created_by || '',
                created_at: p.created_at,
                updated_at: p.updated_at
            },
            items,
            advancePayment
        });

    } catch (error) {
        console.error('Load proforma error:', error);
        res.status(500).json({ success: false, message: 'Failed to load proforma: ' + error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// POST /api/wizard/:jobId/finalize
// Transfers the latest proforma (or passed proformaId) into official invoice, sets flag
app.post('/api/wizard/:jobId/finalize', async (req, res) => {
    let conn;
    try {
        const { jobId } = req.params;
        const { proformaId, finalizedBy, notes } = req.body;

        if (!proformaId) {
            return res.status(400).json({ success: false, message: 'proformaId is required' });
        }

        conn = await getDbConnection();
        await conn.beginTransaction();

        // 1. Load the proforma record
        const profRows = await conn.query(`
            SELECT * FROM proforma_invoices WHERE id = ? AND job_card_id = ?
        `, [proformaId, jobId]);
        if (profRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, message: 'Proforma not found for this job card' });
        }

        const prof = profRows[0];
        let items = [];
        let advancePayment = null;
        try { items = prof.items_json ? (typeof prof.items_json === 'string' ? JSON.parse(prof.items_json) : prof.items_json) : []; } catch(e) {}
        try { advancePayment = prof.advance_payment_json ? (typeof prof.advance_payment_json === 'string' ? JSON.parse(prof.advance_payment_json) : prof.advance_payment_json) : null; } catch(e) {}

        // 2. Get the job card
        const jcRows = await conn.query(`SELECT id, invoice_no, customer_id FROM job_cards WHERE id = ?`, [jobId]);
        if (jcRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ success: false, message: 'Job card not found' });
        }
        const jc = jcRows[0];

        // 3. Resolve official invoice number
        let officialInvoiceNo = jc.invoice_no;
        if (!officialInvoiceNo || officialInvoiceNo.startsWith('PROF-') || officialInvoiceNo.trim() === '') {
            officialInvoiceNo = await generateInvoiceNumber();
        }

        // 4. Check if invoice record already exists
        const existingInv = await conn.query(
            `SELECT id FROM invoices WHERE job_card_id = ? ORDER BY created_at DESC LIMIT 1`,
            [jc.id]
        );

        let invoiceId;
        const subtotal = parseFloat(prof.subtotal) || 0;
        const discountAmount = parseFloat(prof.discount_amount) || 0;
        const total = Math.max(parseFloat(prof.total) || 0, 0);

        // 5. Get discount reason
        const discountReason = prof.discount_reason || '';

        if (existingInv.length > 0) {
            invoiceId = existingInv[0].id;
            await conn.query(`
                UPDATE invoices SET
                    invoice_no = ?, subtotal = ?, tax = 0, total = ?,
                    discount_amount = ?, discount_reason = ?,
                    status = 'sent', notes = ?, updated_at = NOW()
                WHERE id = ?
            `, [officialInvoiceNo, subtotal, total, discountAmount, discountReason, notes || prof.notes || '', invoiceId]);

            await conn.query(`DELETE FROM invoice_items WHERE invoice_id = ?`, [invoiceId]);
            await conn.query(`DELETE FROM advance_payments WHERE invoice_id = ?`, [invoiceId]);
        } else {
            invoiceId = uuidv4();
            await conn.query(`
                INSERT INTO invoices
                    (id, invoice_no, job_card_id, customer_id, date, due_date, 
                     subtotal, tax, total, discount_amount, discount_reason,
                     status, notes, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 30 DAY), 
                        ?, 0, ?, ?, ?, 'sent', ?, ?, NOW(), NOW())
            `, [invoiceId, officialInvoiceNo, jc.id, jc.customer_id, 
                subtotal, total, discountAmount, discountReason, notes || prof.notes || '', finalizedBy || 'system']);
        }

        // 6. Insert invoice items
        for (const item of items) {
            const chargeType = item.charge_type || (item.type === 'marginal' ? 'marginal' : 'required');
            await conn.query(`
                INSERT INTO invoice_items (invoice_id, description, charge_type, quantity, unit, rate, amount, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
            `, [
                invoiceId,
                item.description || '',
                chargeType,
                parseFloat(item.quantity) || 0,
                item.unit || 'nos',
                parseFloat(item.rate) || parseFloat(item.unit_price) || 0,
                parseFloat(item.amount) || 0
            ]);
        }

        // 7. Insert advance payment
        if (advancePayment && parseFloat(advancePayment.amount) > 0) {
            await conn.query(`
                INSERT INTO advance_payments
                    (id, invoice_id, amount, payment_date, payment_method, reference_number, notes, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `, [
                uuidv4(), invoiceId,
                parseFloat(advancePayment.amount),
                advancePayment.date || new Date().toISOString().split('T')[0],
                advancePayment.method || 'cash',
                advancePayment.reference || '',
                advancePayment.notes || '',
                finalizedBy || 'system'
            ]);
        }

        // 8. Update job card
        await conn.query(
            `UPDATE job_cards SET invoice_no = ?, updated_at = NOW() WHERE id = ?`,
            [officialInvoiceNo, jc.id]
        );

        await conn.commit();

        res.json({
            success: true,
            message: 'Official invoice issued successfully',
            invoiceId,
            invoiceNo: officialInvoiceNo,
            jobCardId: jc.id
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Finalize wizard error:', error);
        res.status(500).json({ success: false, message: 'Failed to finalize invoice: ' + error.message });
    } finally {
        if (conn) await conn.end();
    }
});

// 6. Finalize & Convert Draft Invoice into Official Finalized Invoice
app.post('/api/invoices/:id/finalize', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { finalizedBy } = req.body;
        conn = await getDbConnection();

        const check = await conn.query(`SELECT * FROM invoices WHERE id = ?`, [id]);
        if (check.length === 0) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }

        const inv = check[0];
        if (inv.status === 'finalized' || inv.status === 'paid' || inv.status === 'sent') {
            return res.status(400).json({ success: false, message: 'Invoice is already finalized and verified' });
        }

        let officialNo = inv.invoice_no;
        if (!officialNo || officialNo.startsWith('PROF-')) {
            const jcInfo = await conn.query(`SELECT invoice_no FROM job_cards WHERE id = ?`, [inv.job_card_id]);
            if (jcInfo.length > 0 && jcInfo[0].invoice_no && jcInfo[0].invoice_no.trim() !== '' && !jcInfo[0].invoice_no.startsWith('PROF-')) {
                officialNo = jcInfo[0].invoice_no;
            } else if (!officialNo || officialNo.startsWith('PROF-')) {
                const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
                const randomCode = Math.floor(1000 + Math.random() * 9000);
                officialNo = `INV-${dateStr}-${randomCode}`;
            }
        }

        await conn.query(`
            UPDATE invoices 
            SET invoice_no = ?, status = 'finalized', updated_at = NOW(), created_by = COALESCE(?, created_by)
            WHERE id = ?
        `, [officialNo, finalizedBy || null, id]);

        if (inv.job_card_id && officialNo) {
            await conn.query(`UPDATE job_cards SET invoice_no = ? WHERE id = ?`, [officialNo, inv.job_card_id]);
        }

        res.json({
            success: true,
            message: 'Invoice finalized and verified successfully!',
            officialInvoiceNo: officialNo
        });
    } catch (error) {
        console.error('Error finalizing invoice:', error);
        res.status(500).json({ success: false, message: 'Failed to finalize invoice', error: error.message });
    } finally {
        if (conn) await conn.end();
    }
});

handlebars.registerHelper('startsWith', function(str, prefix) {
    if (!str || !prefix) return false;
    return str.toUpperCase().startsWith(prefix.toUpperCase());
});

// Also register other helpers if needed
handlebars.registerHelper('eq', function(a, b) {
    return a === b;
});
// ==================== JOB CARD PDF GENERATION WITH QUEUE ====================
app.get('/api/jobcards/:id/pdf', async (req, res) => {
    const { id } = req.params;
    
    // Queue the PDF request instead of generating immediately
    queuePDFRequest(id, res, 'jobcard');
});

async function generateJobCardPDF(id, res, browser) {
    let conn;
    try {
        conn = await getDbConnection();
        let jobCard = null;
        
        try {
            const query = `
                SELECT 
                    jc.job_no, 
                    DATE_FORMAT(jc.operation_date, '%d/%m/%Y') as job_date,
                    jc.hawb as hbl,
                    jc.mawb as mawb,
                    jc.habw as habw,
                    jc.mabw as mabw,
                    jc.road_waybill as road_waybill,
                    jc.bayan_no as bayan_no,
                    jc.declaration_number as declaration_number,
                    jc.transporter_name as transporter,
                    DATE_FORMAT(jc.atd, '%d/%m/%Y') as atd, 
                    DATE_FORMAT(jc.ata, '%d/%m/%Y') as ata, 
                    c.name AS customer,
                    cs.name AS consignee,
                    sh.name AS shipper,
                    rp.name AS salesman,
                    jc.commercial_invoice_no,
                    jc.gross_weight,
                    jc.no_of_packages,
                    jc.packages_unit as package_type,
                    jc.master_remarks,
                    jc.transport_mode_id,
                    tm.code as transport_mode_code
                FROM job_cards jc
                LEFT JOIN customers c ON jc.customer_id = c.id
                LEFT JOIN consignees cs ON jc.consignee_id = cs.id
                LEFT JOIN shippers sh ON jc.shipper_id = sh.id
                LEFT JOIN responsible_persons rp ON jc.responsible_person_id = rp.id
                LEFT JOIN transport_modes tm ON jc.transport_mode_id = tm.id
                WHERE jc.id = ? OR jc.job_no = ?
            `;
            const rows = await conn.query(query, [id, id]);
            if (rows.length > 0) {
                jobCard = rows[0];
            } else {
                return res.status(404).send('Job card not found');
            }
        } finally {
            if (conn) await conn.release();
        }

        // Debug: Log all fields to see what's available
        console.log('Job Card Data:', JSON.stringify(jobCard, null, 2));
        console.log('mawb field value:', jobCard.mawb);
        console.log('mabw field value:', jobCard.mabw);

        // ALWAYS use MAWB from the database - regardless of transport mode
        // Priority: mawb field first, then mabw as fallback
        const documentNumber = jobCard.mawb || jobCard.mabw || 'N/A';
        
        // ALWAYS use "MAWB" as the label - regardless of transport mode
        const documentLabel = 'MAWB';

        console.log('Job No:', jobCard.job_no);
        console.log('MAWB Number:', documentNumber);

        const JOB_DATA = {
            job_no: jobCard.job_no || 'N/A',
            job_date: jobCard.job_date || 'N/A',
            document_label: documentLabel,
            document_number: documentNumber,
            bayan_no: jobCard.bayan_no || 'N/A',
            declaration_number: jobCard.declaration_number || 'N/A',
            transporter: jobCard.transporter || 'N/A',
            atd: jobCard.atd || 'N/A',
            ata: jobCard.ata || 'N/A',
            customer: jobCard.customer || 'N/A',
            consignee: jobCard.consignee || 'N/A',
            shipper: jobCard.shipper || 'N/A',
            salesman: jobCard.salesman || 'N/A',
            commercial_invoice_no: jobCard.commercial_invoice_no || 'N/A',
            gross_weight: jobCard.gross_weight || '0.00',
            no_of_packages: jobCard.no_of_packages || '0',
            package_type: jobCard.package_type || 'pcs',
            master_remarks: jobCard.master_remarks || 'N/A',
            transport_mode: jobCard.transport_mode_code || 'N/A'
        };

        const COMPANY = {
            name: 'ALEID INTERNATIONAL LOGISTICS COMPANY',
            address_line1: 'Office No 10, M Floor, Tala Mall, St. 79, Plot 20, Dajeej - 80000,',
            address_line2: 'Farwaniya',
            country: 'Kuwait',
            phone: '24311005',
            email: 'sales@aleidlogistics.com'
        };

        const templatePath = path.join(__dirname, 'templates', 'jobcard-template.hbs');
        const templateHtml = fs.readFileSync(templatePath, 'utf8');
        const template = handlebars.compile(templateHtml);

        let logoBase64 = '';
        try {
            const logoPaths = [
                path.join(__dirname, '..', 'backend', 'logo.svg'),
                path.join(__dirname, 'logo.svg'),
                path.join(__dirname, '..', 'logo.svg'),
                path.join(__dirname, '..', '..', 'logo.svg'),
                path.join(__dirname, 'logo.png'),
                path.join(__dirname, '..', 'logo.png')
            ];
            
            for (const logoPath of logoPaths) {
                if (fs.existsSync(logoPath)) {
                    const ext = path.extname(logoPath).toLowerCase();
                    let mimeType = 'image/svg+xml';
                    if (ext === '.png') mimeType = 'image/png';
                    else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                    
                    const data = fs.readFileSync(logoPath);
                    logoBase64 = 'data:' + mimeType + ';base64,' + data.toString('base64');
                    console.log('Logo loaded from:', logoPath);
                    break;
                }
            }
            
            if (!logoBase64) {
                console.log('Logo not found in any expected paths');
            }
        } catch (err) {
            console.log('Logo loading error:', err.message);
        }

        const data = {
            logo: logoBase64,
            company_name: COMPANY.name,
            company_address_line1: COMPANY.address_line1,
            company_address_line2: COMPANY.address_line2,
            company_country: COMPANY.country,
            company_phone: COMPANY.phone,
            company_email: COMPANY.email,
            job_no: JOB_DATA.job_no,
            job_date: JOB_DATA.job_date,
            document_label: JOB_DATA.document_label,
            document_number: JOB_DATA.document_number,
            bayan_no: JOB_DATA.bayan_no,
            declaration_number: JOB_DATA.declaration_number,
            transporter: JOB_DATA.transporter,
            atd_date: JOB_DATA.atd,
            ata_date: JOB_DATA.ata,
            customer_name: JOB_DATA.customer,
            consignee_name: JOB_DATA.consignee,
            shipper_name: JOB_DATA.shipper,
            salesman_name: JOB_DATA.salesman,
            commercial_inv_no: JOB_DATA.commercial_invoice_no,
            gross_weight: JOB_DATA.gross_weight,
            no_of_packages: JOB_DATA.no_of_packages,
            package_type: JOB_DATA.package_type,
            master_remarks: JOB_DATA.master_remarks,
            transport_mode: JOB_DATA.transport_mode,
            generated_date: new Date().toLocaleString('en-US', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }),
            year: new Date().getFullYear()
        };

        console.log('Generating Job Card PDF for:', data.job_no);
        console.log('MAWB Number:', data.document_number);

        const html = template(data);

        // Use the provided browser from the pool
        const page = await browser.newPage();
        await page.setContent(html, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: {
                top: '20px',
                bottom: '20px',
                left: '20px',
                right: '20px'
            },
            preferCSSPageSize: true
        });

        await page.close(); // Close page but keep browser

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="JOB_CARD_' + data.job_no + '.pdf"');
        res.setHeader('Content-Length', pdf.length);
        res.send(pdf);

    } catch (error) {
        console.error('Job card PDF generation error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: 'Failed to generate job card PDF: ' + error.message
            });
        }
    } finally {
        if (conn) await conn.release();
    }
}






// GET all shippers
app.get('/api/shippers', async (req, res) => {
    let conn;
    try {
        const { search = '', limit = 100 } = req.query;

        conn = await getDbConnection();

        let query = `
            SELECT id, name, reference_number, phone, email, company, 
                   address, country, contact_person, created_at, updated_at
            FROM shippers 
            WHERE 1=1
        `;

        const params = [];

        if (search && search.length > 0) {
            query += ` AND (name LIKE ? OR company LIKE ? OR email LIKE ? OR phone LIKE ?)`;
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        query += ` ORDER BY name ASC LIMIT ?`;
        params.push(parseInt(limit));

        const shippers = await conn.query(query, params);

        res.json({
            success: true,
            data: shippers
        });

    } catch (error) {
        console.error('Get shippers error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get shippers: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// GET single shipper by ID
app.get('/api/shippers/search', async (req, res) => {
    let conn;
    try {
        const { q } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        conn = await getDbConnection();

        const shippers = await conn.query(`
            SELECT 
                name,
                company,
                country,
                reference_number
            FROM shippers
            WHERE name LIKE ?
            ORDER BY name
            LIMIT 10
        `, [`%${q}%`]);

        res.json(shippers);

    } catch (error) {
        console.error('Search shippers error:', error);
        res.status(500).json([]);
    } finally {
        if (conn) await conn.end();
    }
});

app.get('/api/shippers/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid shipper ID format'
            });
        }

        conn = await getDbConnection();

        const shipper = await conn.query(
            `SELECT id, name, reference_number, phone, email, company, 
                    address, country, contact_person, created_at, updated_at
             FROM shippers WHERE id = ?`,
            [id]
        );

        if (shipper.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Shipper not found'
            });
        }

        res.json({
            success: true,
            data: shipper[0]
        });

    } catch (error) {
        console.error('Get shipper error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get shipper: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// CREATE new shipper
app.post('/api/shippers', async (req, res) => {
    let conn;
    try {
        const { name, reference_number, phone, email, company, address, country, contact_person } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Shipper name is required'
            });
        }

        conn = await getDbConnection();

        const shipperId = uuidv4();

        await conn.query(`
            INSERT INTO shippers (
id, name, reference_number, phone, email, company,
                address, country, contact_person, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            shipperId,
            name.trim(),
            reference_number || null,
            phone || null,
            email || null,
            company || null,
            address || null,
            country || null,
            contact_person || null,
            new Date(),
            new Date()
        ]);

        res.json({
            success: true,
            message: 'Shipper created successfully',
            id: shipperId,
            data: {
                id: shipperId,
                name: name.trim(),
                reference_number: reference_number || null,
                phone: phone || null,
                email: email || null,
                company: company || null,
                address: address || null,
                country: country || null,
                contact_person: contact_person || null
            }
        });

    } catch (error) {
        console.error('Create shipper error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create shipper: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// UPDATE shipper
app.put('/api/shippers/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { name, reference_number, phone, email, company, address, country, contact_person } = req.body;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid shipper ID format'
            });
        }

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Shipper name is required'
            });
        }

        conn = await getDbConnection();

        const existing = await conn.query('SELECT id FROM shippers WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Shipper not found'
            });
        }

        await conn.query(`
            UPDATE shippers 
            SET name = ?, reference_number = ?, phone = ?, email = ?, 
                company = ?, address = ?, country = ?, contact_person = ?,
                updated_at = ?
            WHERE id = ?
        `, [
            name.trim(),
            reference_number || null,
            phone || null,
            email || null,
            company || null,
            address || null,
            country || null,
            contact_person || null,
            new Date(),
            id
        ]);

        res.json({
            success: true,
            message: 'Shipper updated successfully'
        });

    } catch (error) {
        console.error('Update shipper error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update shipper: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// DELETE shipper
app.delete('/api/shippers/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid shipper ID format'
            });
        }

        conn = await getDbConnection();

        const existing = await conn.query('SELECT id FROM shippers WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Shipper not found'
            });
        }

        // Check if shipper is referenced in job cards
        const jobCards = await conn.query(
            'SELECT COUNT(*) as count FROM job_cards WHERE shipper_id = ?',
            [id]
        );

        if (jobCards[0]?.count > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete shipper with ${jobCards[0].count} associated job cards. Archive or reassign first.`
            });
        }

        await conn.query('DELETE FROM shippers WHERE id = ?', [id]);

        res.json({
            success: true,
            message: 'Shipper deleted successfully'
        });

    } catch (error) {
        console.error('Delete shipper error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete shipper: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Search shippers (for autocomplete)
app.get('/api/shippers/search', async (req, res) => {
    let conn;
    try {
        const { q } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        conn = await getDbConnection();

        const shippers = await conn.query(`
            SELECT id, name, reference_number, company, phone, email
            FROM shippers 
            WHERE name LIKE ? OR company LIKE ? OR reference_number LIKE ?
            ORDER BY name
            LIMIT 15
        `, [`%${q}%`, `%${q}%`, `%${q}%`]);

        res.json(shippers);

    } catch (error) {
        console.error('Search shippers error:', error);
        res.status(500).json([]);
    } finally {
        if (conn) await conn.end();
    }
});

// ==================== CONSIGNEES ENDPOINTS ====================

// GET all consignees
app.get('/api/consignees', async (req, res) => {
    let conn;
    try {
        const { search = '', limit = 100 } = req.query;

        conn = await getDbConnection();

        let query = `
            SELECT id, name, reference_number, phone, email, address, country, created_at, updated_at
            FROM consignees 
            WHERE 1=1
        `;

        const params = [];

        if (search && search.length > 0) {
            query += ` AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)`;
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, searchPattern);
        }

        query += ` ORDER BY name ASC LIMIT ?`;
        params.push(parseInt(limit));

        const consignees = await conn.query(query, params);

        res.json({
            success: true,
            data: consignees
        });

    } catch (error) {
        console.error('Get consignees error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get consignees: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// GET single consignee by ID
app.get('/api/consignees/search', async (req, res) => {
    let conn;
    try {
        const { q } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        conn = await getDbConnection();

        const consignees = await conn.query(`
            SELECT id, name, reference_number, phone, email
            FROM consignees 
            WHERE name LIKE ? OR reference_number LIKE ?
            ORDER BY name
            LIMIT 15
        `, [`%${q}%`, `%${q}%`]);

        res.json(consignees);

    } catch (error) {
        console.error('Search consignees error:', error);
        res.status(500).json([]);
    } finally {
        if (conn) await conn.end();
    }
});

app.get('/api/consignees/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid consignee ID format'
            });
        }

        conn = await getDbConnection();

        const consignee = await conn.query(
            `SELECT id, name, reference_number, phone, email, address, country, created_at, updated_at
             FROM consignees WHERE id = ?`,
            [id]
        );

        if (consignee.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Consignee not found'
            });
        }

        res.json({
            success: true,
            data: consignee[0]
        });

    } catch (error) {
        console.error('Get consignee error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get consignee: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// CREATE new consignee
app.post('/api/consignees', async (req, res) => {
    let conn;
    try {
        const { name, reference_number, phone, email, address, country } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Consignee name is required'
            });
        }

        conn = await getDbConnection();

        const consigneeId = uuidv4();

        await conn.query(`
            INSERT INTO consignees (
id, name, reference_number, phone, email, address, country, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            consigneeId,
            name.trim(),
            reference_number || null,
            phone || null,
            email || null,
            address || null,
            country || null,
            new Date(),
            new Date()
        ]);

        res.json({
            success: true,
            message: 'Consignee created successfully',
            id: consigneeId,
            data: {
                id: consigneeId,
                name: name.trim(),
                reference_number: reference_number || null,
                phone: phone || null,
                email: email || null,
                address: address || null,
                country: country || null
            }
        });

    } catch (error) {
        console.error('Create consignee error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create consignee: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// UPDATE consignee
app.put('/api/consignees/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { name, reference_number, phone, email, address, country } = req.body;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid consignee ID format'
            });
        }

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Consignee name is required'
            });
        }

        conn = await getDbConnection();

        const existing = await conn.query('SELECT id FROM consignees WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Consignee not found'
            });
        }

        await conn.query(`
            UPDATE consignees 
            SET name = ?, reference_number = ?, phone = ?, email = ?, 
                address = ?, country = ?, updated_at = ?
            WHERE id = ?
        `, [
            name.trim(),
            reference_number || null,
            phone || null,
            email || null,
            address || null,
            country || null,
            new Date(),
            id
        ]);

        res.json({
            success: true,
            message: 'Consignee updated successfully'
        });

    } catch (error) {
        console.error('Update consignee error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update consignee: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// DELETE consignee
app.delete('/api/consignees/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid consignee ID format'
            });
        }

        conn = await getDbConnection();

        const existing = await conn.query('SELECT id FROM consignees WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Consignee not found'
            });
        }

        // Check if consignee has contact persons
        const contactPersons = await conn.query(
            'SELECT COUNT(*) as count FROM contact_persons WHERE consignee_id = ?',
            [id]
        );

        if (contactPersons[0]?.count > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete consignee with ${contactPersons[0].count} associated contact persons. Archive or reassign first.`
            });
        }

        await conn.query('DELETE FROM consignees WHERE id = ?', [id]);

        res.json({
            success: true,
            message: 'Consignee deleted successfully'
        });

    } catch (error) {
        console.error('Delete consignee error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete consignee: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Search consignees (for autocomplete)


// ==================== AGENTS ENDPOINTS ====================

// GET all agents
app.get('/api/agents', async (req, res) => {
    let conn;
    try {
        const { search = '', limit = 100 } = req.query;

        conn = await getDbConnection();

        let query = `
            SELECT id, name, phone, email, company, address, country, created_at, updated_at
            FROM agents 
            WHERE 1=1
        `;

        const params = [];

        if (search && search.length > 0) {
            query += ` AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ?)`;
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        query += ` ORDER BY name ASC LIMIT ?`;
        params.push(parseInt(limit));

        const agents = await conn.query(query, params);

        res.json({
            success: true,
            data: agents
        });

    } catch (error) {
        console.error('Get agents error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get agents: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// GET single agent by ID
app.get('/api/agents/search', async (req, res) => {
    let conn;
    try {
        const { q } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        conn = await getDbConnection();

        const agents = await conn.query(`
            SELECT id, name, phone, email, company
            FROM agents 
            WHERE name LIKE ? OR company LIKE ?
            ORDER BY name
            LIMIT 15
        `, [`%${q}%`, `%${q}%`]);

        res.json(agents);

    } catch (error) {
        console.error('Search agents error:', error);
        res.status(500).json([]);
    } finally {
        if (conn) await conn.end();
    }
});

app.get('/api/agents/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid agent ID format'
            });
        }

        conn = await getDbConnection();

        const agent = await conn.query(
            `SELECT id, name, phone, email, company, address, country, created_at, updated_at
             FROM agents WHERE id = ?`,
            [id]
        );

        if (agent.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent not found'
            });
        }

        res.json({
            success: true,
            data: agent[0]
        });

    } catch (error) {
        console.error('Get agent error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get agent: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// CREATE new agent
app.post('/api/agents', async (req, res) => {
    let conn;
    try {
        const { name, phone, email, company, address, country } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Agent name is required'
            });
        }

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Agent phone number is required'
            });
        }

        conn = await getDbConnection();

        const agentId = uuidv4();

        await conn.query(`
            INSERT INTO agents (
id, name, phone, email, company, address, country, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            agentId,
            name.trim(),
            phone.trim(),
            email || null,
            company || null,
            address || null,
            country || null,
            new Date(),
            new Date()
        ]);

        res.json({
            success: true,
            message: 'Agent created successfully',
            id: agentId,
            data: {
                id: agentId,
                name: name.trim(),
                phone: phone.trim(),
                email: email || null,
                company: company || null,
                address: address || null,
                country: country || null
            }
        });

    } catch (error) {
        console.error('Create agent error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create agent: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// UPDATE agent
app.put('/api/agents/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { name, phone, email, company, address, country } = req.body;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid agent ID format'
            });
        }

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Agent name is required'
            });
        }

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Agent phone number is required'
            });
        }

        conn = await getDbConnection();

        const existing = await conn.query('SELECT id FROM agents WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent not found'
            });
        }

        await conn.query(`
            UPDATE agents 
            SET name = ?, phone = ?, email = ?, company = ?, 
                address = ?, country = ?, updated_at = ?
            WHERE id = ?
        `, [
            name.trim(),
            phone.trim(),
            email || null,
            company || null,
            address || null,
            country || null,
            new Date(),
            id
        ]);

        res.json({
            success: true,
            message: 'Agent updated successfully'
        });

    } catch (error) {
        console.error('Update agent error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update agent: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// DELETE agent
app.delete('/api/agents/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid agent ID format'
            });
        }

        conn = await getDbConnection();

        const existing = await conn.query('SELECT id FROM agents WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Agent not found'
            });
        }

        await conn.query('DELETE FROM agents WHERE id = ?', [id]);

        res.json({
            success: true,
            message: 'Agent deleted successfully'
        });

    } catch (error) {
        console.error('Delete agent error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete agent: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Search agents (for autocomplete)


// ==================== DRIVERS ENDPOINTS ====================

// GET all drivers
app.get('/api/drivers', async (req, res) => {
    let conn;
    try {
        const { search = '', limit = 100 } = req.query;

        conn = await getDbConnection();

        let query = `
            SELECT id, name, phone, email, license_number, address, created_at, updated_at
            FROM drivers 
            WHERE 1=1
        `;

        const params = [];

        if (search && search.length > 0) {
            query += ` AND (name LIKE ? OR phone LIKE ? OR email LIKE ? OR license_number LIKE ?)`;
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        query += ` ORDER BY name ASC LIMIT ?`;
        params.push(parseInt(limit));

        const drivers = await conn.query(query, params);

        res.json({
            success: true,
            data: drivers
        });

    } catch (error) {
        console.error('Get drivers error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get drivers: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// GET single driver by ID
app.get('/api/drivers/search', async (req, res) => {
    let conn;
    try {
        const { q } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        conn = await getDbConnection();

        const drivers = await conn.query(`
            SELECT id, name, phone, license_number
            FROM drivers 
            WHERE name LIKE ? OR phone LIKE ? OR license_number LIKE ?
            ORDER BY name
            LIMIT 15
        `, [`%${q}%`, `%${q}%`, `%${q}%`]);

        res.json(drivers);

    } catch (error) {
        console.error('Search drivers error:', error);
        res.status(500).json([]);
    } finally {
        if (conn) await conn.end();
    }
});

app.get('/api/drivers/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid driver ID format'
            });
        }

        conn = await getDbConnection();

        const driver = await conn.query(
            `SELECT id, name, phone, email, license_number, address, created_at, updated_at
             FROM drivers WHERE id = ?`,
            [id]
        );

        if (driver.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        res.json({
            success: true,
            data: driver[0]
        });

    } catch (error) {
        console.error('Get driver error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get driver: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// CREATE new driver
app.post('/api/drivers', async (req, res) => {
    let conn;
    try {
        const { name, phone, email, license_number, address } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Driver name is required'
            });
        }

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Driver phone number is required'
            });
        }

        conn = await getDbConnection();

        const driverId = uuidv4();

        await conn.query(`
            INSERT INTO drivers (
id, name, phone, email, license_number, address, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            driverId,
            name.trim(),
            phone.trim(),
            email || null,
            license_number || null,
            address || null,
            new Date(),
            new Date()
        ]);

        res.json({
            success: true,
            message: 'Driver created successfully',
            id: driverId,
            data: {
                id: driverId,
                name: name.trim(),
                phone: phone.trim(),
                email: email || null,
                license_number: license_number || null,
                address: address || null
            }
        });

    } catch (error) {
        console.error('Create driver error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create driver: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// UPDATE driver
app.put('/api/drivers/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { name, phone, email, license_number, address } = req.body;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid driver ID format'
            });
        }

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Driver name is required'
            });
        }

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Driver phone number is required'
            });
        }

        conn = await getDbConnection();

        const existing = await conn.query('SELECT id FROM drivers WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        await conn.query(`
            UPDATE drivers 
            SET name = ?, phone = ?, email = ?, license_number = ?, 
                address = ?, updated_at = ?
            WHERE id = ?
        `, [
            name.trim(),
            phone.trim(),
            email || null,
            license_number || null,
            address || null,
            new Date(),
            id
        ]);

        res.json({
            success: true,
            message: 'Driver updated successfully'
        });

    } catch (error) {
        console.error('Update driver error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update driver: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// DELETE driver
app.delete('/api/drivers/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid driver ID format'
            });
        }

        conn = await getDbConnection();

        const existing = await conn.query('SELECT id FROM drivers WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Driver not found'
            });
        }

        await conn.query('DELETE FROM drivers WHERE id = ?', [id]);

        res.json({
            success: true,
            message: 'Driver deleted successfully'
        });

    } catch (error) {
        console.error('Delete driver error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete driver: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Search drivers (for autocomplete)


// ==================== CONTACT PERSONS ENDPOINTS ====================

// GET all contact persons
app.get('/api/contact_persons', async (req, res) => {
    let conn;
    try {
        const { search = '', consignee_id = null, limit = 100 } = req.query;

        conn = await getDbConnection();

        let query = `
            SELECT id, name, reference_number, phone, email, company, consignee_id, created_at, updated_at
            FROM contact_persons 
            WHERE 1=1
        `;

        const params = [];

        if (consignee_id) {
            query += ` AND consignee_id = ?`;
            params.push(consignee_id);
        }

        if (search && search.length > 0) {
            query += ` AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ?)`;
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, searchPattern, searchPattern);
        }

        query += ` ORDER BY name ASC LIMIT ?`;
        params.push(parseInt(limit));

        const contacts = await conn.query(query, params);

        // Get consignee names for each contact
        for (const contact of contacts) {
            if (contact.consignee_id) {
                const consignee = await conn.query(
                    'SELECT name FROM consignees WHERE id = ?',
                    [contact.consignee_id]
                );
                contact.consignee_name = consignee.length > 0 ? consignee[0].name : null;
            }
        }

        res.json({
            success: true,
            data: contacts
        });

    } catch (error) {
        console.error('Get contacts error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get contacts: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// GET single contact person by ID
app.get('/api/contact_persons/search', async (req, res) => {
    let conn;
    try {
        const { q, consignee_id = null } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        conn = await getDbConnection();

        let query = `
            SELECT id, name, reference_number, phone, email, company, consignee_id
            FROM contact_persons 
            WHERE (name LIKE ? OR phone LIKE ? OR email LIKE ?)
        `;

        const params = [`%${q}%`, `%${q}%`, `%${q}%`];

        if (consignee_id) {
            query += ` AND consignee_id = ?`;
            params.push(consignee_id);
        }

        query += ` ORDER BY name LIMIT 15`;

        const contacts = await conn.query(query, params);

        res.json(contacts);

    } catch (error) {
        console.error('Search contacts error:', error);
        res.status(500).json([]);
    } finally {
        if (conn) await conn.end();
    }
});

app.get('/api/contact_persons/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid contact ID format'
            });
        }

        conn = await getDbConnection();

        const contact = await conn.query(
            `SELECT id, name, reference_number, phone, email, company, consignee_id, created_at, updated_at
             FROM contact_persons WHERE id = ?`,
            [id]
        );

        if (contact.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Contact person not found'
            });
        }

        // Get consignee name if exists
        if (contact[0].consignee_id) {
            const consignee = await conn.query(
                'SELECT name FROM consignees WHERE id = ?',
                [contact[0].consignee_id]
            );
            contact[0].consignee_name = consignee.length > 0 ? consignee[0].name : null;
        }

        res.json({
            success: true,
            data: contact[0]
        });

    } catch (error) {
        console.error('Get contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get contact: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// CREATE new contact person
app.post('/api/contact_persons', async (req, res) => {
    let conn;
    try {
        const { name, reference_number, phone, email, company, consignee_id } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Contact person name is required'
            });
        }

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Contact person phone number is required'
            });
        }

        conn = await getDbConnection();

        // Validate consignee if provided
        if (consignee_id) {
            const consignee = await conn.query('SELECT id FROM consignees WHERE id = ?', [consignee_id]);
            if (consignee.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid consignee ID'
                });
            }
        }

        const contactId = uuidv4();

        await conn.query(`
            INSERT INTO contact_persons (
id, name, reference_number, phone, email, company, consignee_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            contactId,
            name.trim(),
            reference_number || null,
            phone.trim(),
            email || null,
            company || null,
            consignee_id || null,
            new Date(),
            new Date()
        ]);

        res.json({
            success: true,
            message: 'Contact person created successfully',
            id: contactId,
            data: {
                id: contactId,
                name: name.trim(),
                reference_number: reference_number || null,
                phone: phone.trim(),
                email: email || null,
                company: company || null,
                consignee_id: consignee_id || null
            }
        });

    } catch (error) {
        console.error('Create contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create contact: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// UPDATE contact person
app.put('/api/contact_persons/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;
        const { name, reference_number, phone, email, company, consignee_id } = req.body;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid contact ID format'
            });
        }

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Contact person name is required'
            });
        }

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Contact person phone number is required'
            });
        }

        conn = await getDbConnection();

        const existing = await conn.query('SELECT id FROM contact_persons WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Contact person not found'
            });
        }

        // Validate consignee if provided
        if (consignee_id) {
            const consignee = await conn.query('SELECT id FROM consignees WHERE id = ?', [consignee_id]);
            if (consignee.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid consignee ID'
                });
            }
        }

        await conn.query(`
            UPDATE contact_persons 
            SET name = ?, reference_number = ?, phone = ?, email = ?, 
                company = ?, consignee_id = ?, updated_at = ?
            WHERE id = ?
        `, [
            name.trim(),
            reference_number || null,
            phone.trim(),
            email || null,
            company || null,
            consignee_id || null,
            new Date(),
            id
        ]);

        res.json({
            success: true,
            message: 'Contact person updated successfully'
        });

    } catch (error) {
        console.error('Update contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update contact: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// DELETE contact person
app.delete('/api/contact_persons/:id', async (req, res) => {
    let conn;
    try {
        const { id } = req.params;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid contact ID format'
            });
        }

        conn = await getDbConnection();

        const existing = await conn.query('SELECT id FROM contact_persons WHERE id = ?', [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Contact person not found'
            });
        }

        await conn.query('DELETE FROM contact_persons WHERE id = ?', [id]);

        res.json({
            success: true,
            message: 'Contact person deleted successfully'
        });

    } catch (error) {
        console.error('Delete contact error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete contact: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Search contacts (for autocomplete)


// ==================== ENTITY STATUS ENDPOINT ====================

// Get all entities with status (for dashboard)
app.get('/api/entities/status', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();

        const result = {
            customers: await conn.query('SELECT COUNT(*) as count FROM customers'),
            shippers: await conn.query('SELECT COUNT(*) as count FROM shippers'),
            consignees: await conn.query('SELECT COUNT(*) as count FROM consignees'),
            agents: await conn.query('SELECT COUNT(*) as count FROM agents'),
            drivers: await conn.query('SELECT COUNT(*) as count FROM drivers'),
            contacts: await conn.query('SELECT COUNT(*) as count FROM contact_persons')
        };

        res.json({
            success: true,
            data: {
                customers: result.customers[0]?.count || 0,
                shippers: result.shippers[0]?.count || 0,
                consignees: result.consignees[0]?.count || 0,
                agents: result.agents[0]?.count || 0,
                drivers: result.drivers[0]?.count || 0,
                contacts: result.contacts[0]?.count || 0
            }
        });

    } catch (error) {
        console.error('Get entity status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get entity status: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});

async function createEntityTables() {
    try {
        console.log('📦 Creating entity and lookup tables...');

        // ==================== LOOKUP TABLES ====================

        // 1. Cargo Types Lookup
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS cargo_types (
                id VARCHAR(36) PRIMARY KEY,
                code VARCHAR(50) NOT NULL UNIQUE,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                sort_order INT DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_code (code),
                INDEX idx_name (name),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Cargo Types table created');

        // 2. Service Modes Lookup
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS service_modes (
                id VARCHAR(36) PRIMARY KEY,
                code VARCHAR(50) NOT NULL UNIQUE,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                sort_order INT DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_code (code),
                INDEX idx_name (name),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Service Modes table created');

        // 3. Incoterms Lookup
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS incoterms (
                id VARCHAR(36) PRIMARY KEY,
                code VARCHAR(20) NOT NULL UNIQUE,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                sort_order INT DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_code (code),
                INDEX idx_name (name),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Incoterms table created');

        // 4. CC Regime Lookup
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS cc_regimes (
                id VARCHAR(36) PRIMARY KEY,
                code VARCHAR(50) NOT NULL UNIQUE,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                sort_order INT DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_code (code),
                INDEX idx_name (name),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ CC Regimes table created');

        // 5. Ministry Approvals Lookup
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS ministry_approvals (
                id VARCHAR(36) PRIMARY KEY,
                code VARCHAR(50) NOT NULL UNIQUE,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                sort_order INT DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_code (code),
                INDEX idx_name (name),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Ministry Approvals table created');

        // 6. Responsible Persons Lookup
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS responsible_persons (
                id VARCHAR(36) PRIMARY KEY,
                code VARCHAR(50) NOT NULL UNIQUE,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100),
                phone VARCHAR(50),
                department VARCHAR(100),
                is_active BOOLEAN DEFAULT TRUE,
                sort_order INT DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_code (code),
                INDEX idx_name (name),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Responsible Persons table created');

        // 7. Transport Modes Lookup
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS transport_modes (
                id VARCHAR(36) PRIMARY KEY,
                code VARCHAR(20) NOT NULL UNIQUE,
                name VARCHAR(50) NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                sort_order INT DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_code (code),
                INDEX idx_name (name),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Transport Modes table created');

        // 8. Shipment Types Lookup
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS shipment_types (
                id VARCHAR(36) PRIMARY KEY,
                code VARCHAR(20) NOT NULL UNIQUE,
                name VARCHAR(50) NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                sort_order INT DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_code (code),
                INDEX idx_name (name),
                INDEX idx_is_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Shipment Types table created');

        // ==================== JOB CARDS TABLE WITH FOREIGN KEYS ====================
        // Drop existing job_cards table if it exists (backup data first!)
        // await executeQuery(`DROP TABLE IF EXISTS job_cards`);

        await executeQuery(`
            CREATE TABLE IF NOT EXISTS job_cards (
                id VARCHAR(36) NOT NULL PRIMARY KEY,
                job_no VARCHAR(50) NOT NULL UNIQUE,
                operation_date DATE NOT NULL,
                bayan_no VARCHAR(100),
                bayan_date DATE,
                
                 -- ⬇️ ADD THESE TWO LINES ⬇️
                transporter_id VARCHAR(36) DEFAULT NULL,
                transporter_name VARCHAR(200) DEFAULT NULL,

                -- Foreign Keys to Lookup Tables
                cargo_type_id VARCHAR(36),
                service_mode_id VARCHAR(36),
                incoterm_id VARCHAR(36),
                cc_regime_id VARCHAR(36),
                transport_mode_id VARCHAR(36),
                shipment_type_id VARCHAR(36),
                responsible_person_id VARCHAR(36),
                
                -- Other fields
                mawb VARCHAR(100),
                hawb VARCHAR(100),
                cost_center VARCHAR(100),
                cost_center_number VARCHAR(100),
                shipping_line VARCHAR(200),
                
                -- Cargo Metrics
                no_of_packages INT DEFAULT 0,
                packages_unit VARCHAR(20),
                gross_weight DECIMAL(10,2) DEFAULT 0,
                gross_weight_unit VARCHAR(10),
                nett_weight DECIMAL(10,2) DEFAULT 0,
                nett_weight_unit VARCHAR(10),
                chargeable_weight DECIMAL(10,2) DEFAULT 0,
                chargeable_weight_unit VARCHAR(10),
                volume VARCHAR(50),
                shipper_ref_no VARCHAR(100),
                
                -- Stakeholders
                customer_id VARCHAR(36),
                consignee_id VARCHAR(36),
                shipper_id VARCHAR(36),
                agent_id VARCHAR(36),
                pol VARCHAR(200),
                pod VARCHAR(200),
                atd DATETIME,
                ata DATETIME,
                transit_time VARCHAR(50),
                
                -- Customs & Delivery
                driver_name VARCHAR(200),
                vehicle_number VARCHAR(50),
                delivery_location TEXT,
                customs_location VARCHAR(200),
                contact_person VARCHAR(200),
                contact_details VARCHAR(200),
                contact_email VARCHAR(100),
                declaration_number VARCHAR(100),
                declaration_date DATE,
                clearance_date DATE,
                delivery_date DATE,
                cc_number VARCHAR(100),
                requestor_name VARCHAR(200),
                po_number VARCHAR(100),
                delivery_status VARCHAR(50),
                commercial_invoice_no VARCHAR(100),
                master_remarks TEXT,
                delivery_remarks TEXT,
                
                -- Clearance & Deposits
                attested_docs_received VARCHAR(10),
                deposit_category VARCHAR(50),
                deposit_amount DECIMAL(10,2) DEFAULT 0,
                deposit_currency VARCHAR(10),
                deposit_applied_date DATE,
                customs_deposit_release_no VARCHAR(100),
                deposit_refund_last_date DATE,
                clearance_remarks TEXT,
                
                -- Ministry Approvals (JSON array of IDs)
                ministry_approval_ids JSON,
                
                -- Temporary Import Fields
                bank_guarantee_number VARCHAR(100),
                issuance_bank VARCHAR(200),
                bg_amount DECIMAL(10,2) DEFAULT 0,
                ti_bayan_expiry_date DATE,
                ti_file_status VARCHAR(20),
                ti_part_number VARCHAR(200),
                partial_re_export VARCHAR(10),
                partial_re_export_pn VARCHAR(200),
                ti_remarks TEXT,
                
                -- Temporary Export Fields
                te_part_number VARCHAR(200),
                te_bayan_expiry_date DATE,
                te_file_status VARCHAR(20),
                te_remarks TEXT,
                
                -- System fields
                status ENUM('draft', 'submitted', 'approved', 'rejected', 'completed') DEFAULT 'draft',
                created_by VARCHAR(100),
                user_id VARCHAR(36),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                submitted_at DATETIME,
                submitted_by VARCHAR(100),
                approved_at DATETIME,
                approved_by VARCHAR(100),
                completed_at DATETIME,
                invoice_no VARCHAR(100),
                
                -- Foreign Key Constraints
                FOREIGN KEY (cargo_type_id) REFERENCES cargo_types(id) ON DELETE SET NULL,
                FOREIGN KEY (service_mode_id) REFERENCES service_modes(id) ON DELETE SET NULL,
                FOREIGN KEY (incoterm_id) REFERENCES incoterms(id) ON DELETE SET NULL,
                FOREIGN KEY (cc_regime_id) REFERENCES cc_regimes(id) ON DELETE SET NULL,
                FOREIGN KEY (transport_mode_id) REFERENCES transport_modes(id) ON DELETE SET NULL,
                FOREIGN KEY (shipment_type_id) REFERENCES shipment_types(id) ON DELETE SET NULL,
                FOREIGN KEY (responsible_person_id) REFERENCES responsible_persons(id) ON DELETE SET NULL,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
                FOREIGN KEY (consignee_id) REFERENCES consignees(id) ON DELETE SET NULL,
                FOREIGN KEY (shipper_id) REFERENCES shippers(id) ON DELETE SET NULL,
                FOREIGN KEY (transporter_id) REFERENCES transporters(id) ON DELETE SET NULL,
                FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
                
                INDEX idx_job_no (job_no),
                INDEX idx_status (status),
                INDEX idx_customer_id (customer_id),
                INDEX idx_created_at (created_at),
                INDEX idx_operation_date (operation_date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Job Cards table created with foreign keys');



                // Transporters table
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS transporters (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                code VARCHAR(50),
                phone VARCHAR(50),
                email VARCHAR(100),
                address TEXT,
                country VARCHAR(100),
                contact_person VARCHAR(200),
                is_active BOOLEAN DEFAULT TRUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_name (name),
                INDEX idx_code (code),
                INDEX idx_is_active (is_active),
                INDEX idx_phone (phone)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Transporters table created/verified');

        // ==================== INSERT DEFAULT DATA ====================
        await insertDefaultLookupData();

        console.log('✅ All tables created successfully');

    } catch (error) {
        console.error('❌ Entity tables creation failed:', error.message);
        throw error;
    }
}

// ==================== INSERT DEFAULT LOOKUP DATA ====================
async function insertDefaultLookupData() {
    console.log('📝 Inserting default lookup data...');

    // Cargo Types
    const cargoTypes = [
        { code: 'FCL', name: 'FCL', description: 'Full Container Load' },
        { code: 'LCL', name: 'LCL', description: 'Less than Container Load' },
        { code: 'BREAKBULK', name: 'BREAKBULK', description: 'Break Bulk Cargo' },
        { code: 'FTL', name: 'FTL', description: 'Full Truck Load' },
        { code: 'LTL', name: 'LTL', description: 'Less than Truck Load' },
        { code: 'LOOSE', name: 'LOOSE', description: 'Loose Cargo' },
        { code: 'PALLETIZED', name: 'PALLETIZED', description: 'Palletized Cargo' }
    ];

    for (const type of cargoTypes) {
        await executeQuery(`
            INSERT IGNORE INTO cargo_types (
id, code, name, description
            ) VALUES (?, ?, ?, ?)
        `, [uuidv4(), type.code, type.name, type.description]);
    }

    // Service Modes
    const serviceModes = [
        { code: 'DOOR-TO-DOOR', name: 'Door to Door' },
        { code: 'DOOR-TO-PORT', name: 'Door to Port' },
        { code: 'PORT-TO-DOOR', name: 'Port to Door' },
        { code: 'PORT-TO-PORT', name: 'Port to Port' },
        { code: 'CLEARANCE', name: 'Clearance' },
        { code: 'CFS-TO-FACTORY', name: 'CFS to Factory' },
        { code: 'CFS-TO-PORT', name: 'CFS to Port' },
        { code: 'FACTORY-TO-CFS', name: 'Factory to CFS' },
        { code: 'FACTORY-TO-FACTORY', name: 'Factory to Factory' },
        { code: 'WAREHOUSE', name: 'Warehouse' },
        { code: 'INLAND', name: 'Inland' }
    ];

    for (const mode of serviceModes) {
        await executeQuery(`
            INSERT IGNORE INTO service_modes (
id, code, name
            ) VALUES (?, ?, ?)
        `, [uuidv4(), mode.code, mode.name]);
    }

    // Incoterms
    const incoterms = [
        { code: 'EXWORKS', name: 'EXWORKS' },
        { code: 'FOB', name: 'FOB' },
        { code: 'FCA', name: 'FCA' },
        { code: 'DDP', name: 'DDP' },
        { code: 'DAP', name: 'DAP' },
        { code: 'CIF', name: 'CIF' },
        { code: 'C&F', name: 'C&F' }
    ];

    for (const incoterm of incoterms) {
        await executeQuery(`
            INSERT IGNORE INTO incoterms (
id, code, name
            ) VALUES (?, ?, ?)
        `, [uuidv4(), incoterm.code, incoterm.name]);
    }

    // CC Regimes
    const ccRegimes = [
        { code: 'PERMANENT IMPORT', name: 'Permanent Import' },
        { code: 'TEMPORARY IMPORT', name: 'Temporary Import' },
        { code: 'RE-IMPORT', name: 'Re-Import' },
        { code: 'PERMANENT EXPORT', name: 'Permanent Export' },
        { code: 'TEMPORARY EXPORT', name: 'Temporary Export' },
        { code: 'RE-EXPORT', name: 'Re-Export' }
    ];

    for (const regime of ccRegimes) {
        await executeQuery(`
            INSERT IGNORE INTO cc_regimes (
id, code, name
            ) VALUES (?, ?, ?)
        `, [uuidv4(), regime.code, regime.name]);
    }

    // Transport Modes
    const transportModes = [
        { code: 'ROAD', name: 'Road' },
        { code: 'AIR', name: 'Air' },
        { code: 'SEA', name: 'Sea' }
    ];

    for (const mode of transportModes) {
        await executeQuery(`
            INSERT IGNORE INTO transport_modes (
id, code, name
            ) VALUES (?, ?, ?)
        `, [uuidv4(), mode.code, mode.name]);
    }

    // Shipment Types
    const shipmentTypes = [
        { code: 'IMPORT', name: 'Import' },
        { code: 'EXPORT', name: 'Export' }
    ];

    for (const type of shipmentTypes) {
        await executeQuery(`
            INSERT IGNORE INTO shipment_types (
id, code, name
            ) VALUES (?, ?, ?)
        `, [uuidv4(), type.code, type.name]);
    }

    // Responsible Persons
    const responsiblePersons = [
        { code: 'STAFF_01', name: 'Ahmed Ali', email: 'ahmed.ali@aleidlogistics.com', phone: '+965 12345678', department: 'Operations' },
        { code: 'STAFF_02', name: 'Sara Khan', email: 'sara.khan@aleidlogistics.com', phone: '+965 87654321', department: 'Logistics' },
        { code: 'STAFF_03', name: 'Mohammed Omar', email: 'mohammed.omar@aleidlogistics.com', phone: '+965 11223344', department: 'Clearance' }
    ];

    for (const person of responsiblePersons) {
        await executeQuery(`
            INSERT IGNORE INTO responsible_persons (
id, code, name, email, phone, department
            ) VALUES (?, ?, ?, ?, ?, ?)
        `, [uuidv4(), person.code, person.name, person.email, person.phone, person.department]);
    }

    // Ministry Approvals
    const ministryApprovals = [
        { code: 'PAI-52', name: 'PAI (52)' },
        { code: 'MOC-28', name: 'MOC (28)' },
        { code: 'MOH-38', name: 'MOH (38)' },
        { code: 'EPA-30', name: 'EPA (30)' },
        { code: 'PAI-51', name: 'PAI (51)' },
        { code: 'MOI-71', name: 'MOI (71)' },
        { code: 'EPA-WASTE-32', name: 'EPA WASTE MANAGEMENT (32)' },
        { code: 'MOH-29', name: 'MOH (29)' },
        { code: 'MOH-4', name: 'MOH (4)' }
    ];

    for (const approval of ministryApprovals) {
        await executeQuery(`
            INSERT IGNORE INTO ministry_approvals (
id, code, name
            ) VALUES (?, ?, ?)
        `, [uuidv4(), approval.code, approval.name]);
    }

    console.log('✅ Default lookup data inserted successfully');
}
// Get dashboard statistics
app.get('/api/dashboard/stats', async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();

        // Get job card stats
        const jobStats = await conn.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as drafts,
                SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
            FROM job_cards
        `);

        // Get invoice stats
        const invoiceStats = await conn.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as drafts,
                SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid,
                SUM(total) as total_amount
            FROM invoices
        `);

        // Get recent activity
        const recentJobs = await conn.query(`
            SELECT job_no, customer_name, created_at, status 
            FROM job_cards 
            ORDER BY created_at DESC 
            LIMIT 5
        `);

        const recentInvoices = await conn.query(`
            SELECT i.invoice_no, jc.customer_name, i.total, i.created_at, i.status
            FROM invoices i
            LEFT JOIN job_cards jc ON i.job_card_id = jc.id
            ORDER BY i.created_at DESC 
            LIMIT 5
        `);

        res.json({
            success: true,
            stats: {
                jobCards: jobStats[0] || {},
                invoices: invoiceStats[0] || {}
            },
            recent: {
                jobCards: recentJobs,
                invoices: recentInvoices
            }
        });

    } catch (error) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get dashboard statistics'
        });
    } finally {
        if (conn) await conn.end();
    }
});

// ==================== INITIALIZE DATABASE TABLES ====================



// Update your initializeDatabase function to include invoice tables:
async function initializeInvoiceTables() {
    try {
        console.log('📄 Initializing invoice tables...');

        // Invoices table (if not already created)
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS invoices (
                id VARCHAR(36) PRIMARY KEY,
                invoice_no VARCHAR(100) UNIQUE NOT NULL,
                job_card_id VARCHAR(36),
                customer_id VARCHAR(36),
                date DATE NOT NULL,
                due_date DATE NOT NULL,
                subtotal DECIMAL(10,3) DEFAULT 0,
                tax DECIMAL(10,3) DEFAULT 0,
                total DECIMAL(10,3) DEFAULT 0,
                status ENUM('draft', 'sent', 'paid', 'overdue', 'cancelled') DEFAULT 'draft',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                sent_at DATETIME,
                paid_at DATETIME,
                created_by VARCHAR(100),
                notes TEXT,
                FOREIGN KEY (job_card_id) REFERENCES job_cards(id) ON DELETE SET NULL,
                INDEX idx_invoice_no (invoice_no),
                INDEX idx_status (status),
                INDEX idx_date (date),
                INDEX idx_created_at (created_at)
            )
        `);

        // Invoice items table
        await executeQuery(`
            CREATE TABLE IF NOT EXISTS invoice_items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                invoice_id VARCHAR(36) NOT NULL,
                description VARCHAR(500) NOT NULL,
                quantity DECIMAL(10,3) NOT NULL,
                unit VARCHAR(50),
                rate DECIMAL(10,3) NOT NULL,
                amount DECIMAL(10,3) NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
                INDEX idx_invoice_id (invoice_id)
            )
        `);

        console.log('✅ Invoice tables initialized successfully');

    } catch (error) {
        console.error('❌ Invoice tables initialization failed:', error.message);
        throw error;
    }
}

// Call this in your initializeDatabase function
// await initializeInvoiceTables();

// Create invoice from job card - FIXED VERSION
app.post('/api/invoices/create', async (req, res) => {
    let conn;
    try {
        const {
            jobCardId,
            invoiceData,
            charges = []
        } = req.body;

        console.log('Creating invoice with data:', {
            jobCardId,
            invoiceData,
            chargesCount: charges.length
        });

        const userId = req.user?.userId || 'system';

        conn = await getDbConnection();
        await conn.beginTransaction();

        // First, try to find job card by job_no (since frontend sends job_no as jobCardId)
        let jobCard = await conn.query(
            'SELECT * FROM job_cards WHERE job_no = ?',
            [jobCardId]
        );

        // If not found by job_no, try by id
        if (jobCard.length === 0) {
            jobCard = await conn.query(
                'SELECT * FROM job_cards WHERE id = ?',
                [jobCardId]
            );
        }

        if (jobCard.length === 0) {
            return res.status(404).json({
                success: false,
                message: `Job card not found: ${jobCardId}. Please check if the job card exists in the database.`
            });
        }

        const jobCardData = jobCard[0];
        console.log('Found job card:', jobCardData.job_no);

        // Generate invoice number
        const year = new Date().getFullYear();
        const lastInvoice = await conn.query(
            "SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY id DESC LIMIT 1",
            [`INV/${year}/%`]
        );

        let nextNumber = '08231'; // Default starting number

        if (lastInvoice.length > 0) {
            const lastNo = lastInvoice[0].invoice_no;
            console.log('Last invoice number:', lastNo);

            // Extract number from format like "INV/2025/08231"
            const match = lastNo.match(/INV\/\d+\/(\d+)/);
            if (match && match[1]) {
                const lastNum = parseInt(match[1]);
                nextNumber = (lastNum + 1).toString().padStart(5, '0');
                console.log('Next invoice number:', nextNumber);
            }
        }

        const invoiceNumber = `INV/${year}/${nextNumber}`;
        const invoiceId = uuidv4();

        // Calculate totals
        let subtotal = 0;
        charges.forEach(charge => {
            subtotal += parseFloat(charge.amount) || 0;
        });

        console.log('Invoice details:', {
            invoiceNumber,
            invoiceId,
            subtotal,
            jobCardId: jobCardData.id
        });

        // Get customer ID if exists
        let customerId = null;
        if (jobCardData.customer_name) {
            const customer = await conn.query(
                'SELECT id FROM customers WHERE name = ? LIMIT 1',
                [jobCardData.customer_name]
            );
            if (customer.length > 0) {
                customerId = customer[0].id;
            }
        }

        // Create invoice
        await conn.query(`
            INSERT INTO invoices (
id, invoice_no, job_card_id, customer_id,
                date, due_date, subtotal, tax, total,
                status, created_by, created_at, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            invoiceId,
            invoiceNumber,
            jobCardData.id, // Use the actual job card ID from database
            customerId,
            invoiceData.invoiceDate || new Date().toISOString().split('T')[0],
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            subtotal,
            0, // tax
            subtotal,
            'draft',
            userId,
            new Date(),
            invoiceData.notes || ''
        ]);

        // Save invoice items (charges)
        console.log('Saving charges:', charges.length);
        for (const charge of charges) {
            await conn.query(`
                INSERT INTO invoice_items (
invoice_id, description, quantity, unit,
                    rate, amount, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
                invoiceId,
                charge.description,
                parseFloat(charge.qty) || 1,
                'each',
                parseFloat(charge.unitAmount) || 0,
                parseFloat(charge.amount) || 0,
                new Date()
            ]);
        }

        // Update job card with invoice number
        await conn.query(
            'UPDATE job_cards SET invoice_no = ? WHERE id = ?',
            [invoiceNumber, jobCardData.id]
        );

        await conn.commit();

        // Log audit
        await logAudit(userId, 'INVOICE_CREATED', `Invoice created: ${invoiceNumber} for job ${jobCardData.job_no}`, req);

        console.log('Invoice created successfully:', invoiceNumber);

        res.json({
            success: true,
            message: 'Invoice created successfully',
            invoiceId,
            invoiceNumber,
            invoiceData: {
                ...invoiceData,
                charges,
                subtotal,
                total: subtotal
            }
        });

    } catch (error) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (rollbackError) {
                console.error('Rollback error:', rollbackError);
            }
        }
        console.error('Create invoice error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create invoice: ' + error.message,
            details: error.toString()
        });
    } finally {
        if (conn) await conn.end();
    }
});

// Add this function call to your main initializeDatabase() function
// initializeJobCardTables();

// ==================== ERROR HANDLING ====================
// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: `Route ${req.originalUrl} not found`
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Global error:', err);
    res.status(500).json({
        success: false,
        message: 'Internal server error: ' + err.message
    });
});

// ==================== START SERVER ====================
async function startServer() {
    try {
        console.log('🚀 Starting Al Eid POS Backend...');
        console.log('==============================');

        // Test database connection
        const dbConnected = await testDatabaseConnection();
        if (!dbConnected) {
            console.error('⚠️  Starting server with limited functionality (database issues)');
        } else {
            // Initialize database
            await initializeDatabase();
        }

        // Start server
        const server = app.listen(PORT, () => {
            console.log('\n✅ Server started successfully!');
            console.log('--------------------------------------');
            console.log(`🔗 Local: http://localhost:${PORT}`);
            console.log(`🏥 Health Check: http://localhost:${PORT}/api/health`);
            console.log(`🔧 Database Test: http://localhost:${PORT}/api/test-db`);
            console.log('\n📋 Core Endpoints:');
            console.log('   POST /           - Register new user (NO ADMIN APPROVAL)');
            console.log('   POST /api/verify-otp         - Verify OTP & activate account');
            console.log('   POST /api/login              - User login');
            console.log('   POST /api/check-username     - Check username availability');
            console.log('   POST /api/send-verification  - Resend verification code');
            console.log('\n🔐 Admin Endpoints (require token):');
            console.log('   GET  /api/admin/users        - Get all users');
        });

        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`❌ Port ${PORT} is already in use. Stop the existing backend or change PORT in .env.`);
            } else {
                console.error('❌ Backend listener error:', error);
            }
        });

    } catch (error) {
        console.error('❌ Server startup failed:', error.message);
        process.exit(1);
    }
}


async function initializeInvoiceNumbers() {
    try {
        const year = new Date().getFullYear();

        console.log(`🔧 Initializing invoice numbers for year ${year}...`);

        // Check if current year exists in invoice_numbers table
        const existing = await executeQuery(
            'SELECT id, last_number FROM invoice_numbers WHERE year = ?',
            [year]
        );

        if (!existing.success || existing.data.length === 0) {
            // Find the highest invoice number in job_cards for this year
            const maxInvoiceResult = await executeQuery(`
                SELECT invoice_no
                FROM job_cards 
                WHERE invoice_no LIKE 'INV/${year}/%'
                ORDER BY CAST(SUBSTRING_INDEX(invoice_no, '/', -1) AS UNSIGNED) DESC
                LIMIT 1
            `);

            let startingNumber = 8230; // Will generate 8231 as first number

            if (maxInvoiceResult.success && maxInvoiceResult.data.length > 0) {
                const lastInvoice = maxInvoiceResult.data[0].invoice_no;
                const parts = lastInvoice.split('/');
                const lastNum = parseInt(parts[2]);
                if (!isNaN(lastNum) && lastNum > 0) {
                    startingNumber = lastNum;
                    console.log(`Found existing invoices, highest number: ${lastInvoice} (${lastNum})`);

                    // Check for gaps and use the smallest missing number if found
                    const allInvoices = await executeQuery(`
                        SELECT invoice_no
                        FROM job_cards 
                        WHERE invoice_no LIKE 'INV/${year}/%'
                        ORDER BY CAST(SUBSTRING_INDEX(invoice_no, '/', -1) AS UNSIGNED)
                    `);

                    if (allInvoices.success && allInvoices.data.length > 0) {
                        const numbers = allInvoices.data.map(inv => {
                            const parts = inv.invoice_no.split('/');
                            return parseInt(parts[2]) || 0;
                        });

                        // Find first missing number between 8231 and max
                        for (let i = 8231; i <= lastNum; i++) {
                            if (!numbers.includes(i)) {
                                startingNumber = i - 1; // We'll add 1 when generating
                                console.log(`🎯 Found gap at ${i}. Will use ${i} as next invoice number.`);
                                break;
                            }
                        }
                    }
                }
            }

            // Insert the current max number (we'll increment when generating)
            await executeQuery(
                `INSERT INTO invoice_numbers (
year, last_number
            ) VALUES (?, ?)`,
                [year, startingNumber]
            );

            console.log(`✅ Initialized invoice numbers for year ${year} starting from ${startingNumber}`);
        } else {
            console.log(`✅ Invoice numbers already initialized for year ${year}`);
        }

    } catch (error) {
        console.error('Invoice numbers initialization error:', error);
    }
}

// Check for invoice number gaps
app.get('/api/admin/check-invoice-gaps', verifyAdmin, async (req, res) => {
    let conn;
    try {
        const { year = new Date().getFullYear(), limit = 100 } = req.query;

        conn = await getDbConnection();

        // Get recent invoice numbers
        const invoices = await conn.query(`
            SELECT invoice_no
            FROM job_cards 
            WHERE invoice_no LIKE 'INV/${year}/%'
            ORDER BY CAST(SUBSTRING_INDEX(invoice_no, '/', -1) AS UNSIGNED) DESC
            LIMIT ?
        `, [parseInt(limit)]);

        if (invoices.length === 0) {
            return res.json({
                success: true,
                hasGaps: false,
                message: 'No invoices found'
            });
        }

        // Extract numbers and sort ascending
        const numbers = invoices
            .map(inv => {
                const parts = inv.invoice_no.split('/');
                return parseInt(parts[2]) || 0;
            })
            .sort((a, b) => a - b);

        // Check for gaps
        const gaps = [];
        for (let i = 0; i < numbers.length - 1; i++) {
            if (numbers[i + 1] - numbers[i] > 1) {
                for (let missing = numbers[i] + 1; missing < numbers[i + 1]; missing++) {
                    gaps.push(missing);
                }
            }
        }

        res.json({
            success: true,
            hasGaps: gaps.length > 0,
            gapCount: gaps.length,
            gaps: gaps.slice(0, 20), // Return first 20 gaps
            recentNumbers: numbers.slice(-10), // Last 10 numbers
            suggestion: gaps.length > 0 ?
                `Found ${gaps.length} gaps. Next invoice should be: ${gaps[0]}` :
                'No gaps found'
        });

    } catch (error) {
        console.error('Check gaps error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check gaps: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});


// Admin endpoint to find and fix all gaps
app.post('/api/admin/fix-all-invoice-gaps', verifyAdmin, async (req, res) => {
    let conn;
    try {
        conn = await getDbConnection();
        await conn.beginTransaction();

        const year = new Date().getFullYear();

        console.log(`🔧 Scanning for invoice number gaps in year ${year}...`);

        // Get ALL invoice numbers for this year, sorted
        const allInvoices = await conn.query(`
            SELECT id, invoice_no, created_at
            FROM job_cards 
            WHERE invoice_no LIKE 'INV/${year}/%'
            ORDER BY CAST(SUBSTRING_INDEX(invoice_no, '/', -1) AS UNSIGNED)
        `);

        console.log(`Found ${allInvoices.length} invoices`);

        if (allInvoices.length === 0) {
            await conn.rollback();
            return res.json({
                success: true,
                message: 'No invoices found for the current year'
            });
        }

        // Extract just the numbers
        const numbers = allInvoices.map(inv => {
            const parts = inv.invoice_no.split('/');
            return parseInt(parts[2]) || 0;
        });

        console.log('Current number sequence:', numbers.slice(0, 10), '...');

        // Find all gaps
        const gaps = [];
        let expected = 8231; // Your starting number

        for (const num of numbers) {
            if (num > expected) {
                for (let missing = expected; missing < num; missing++) {
                    gaps.push(missing);
                }
            }
            expected = num + 1;
        }

        console.log(`Found ${gaps.length} gaps:`, gaps.slice(0, 10), gaps.length > 10 ? '...' : '');

        if (gaps.length === 0) {
            await conn.rollback();
            return res.json({
                success: true,
                message: 'No gaps found! Invoice numbers are sequential.'
            });
        }

        // Fix gaps by updating invoice_numbers table
        const maxNumber = Math.max(...numbers);
        await conn.query(
            'UPDATE invoice_numbers SET last_number = ? WHERE year = ?',
            [maxNumber, year]
        );

        await conn.commit();

        res.json({
            success: true,
            message: `Found ${gaps.length} gaps. The next invoice will start from ${maxNumber + 1}`,
            gapsFound: gaps.length,
            gaps: gaps.slice(0, 50), // Return first 50 gaps
            nextInvoiceNumber: `INV/${year}/${(maxNumber + 1).toString().padStart(5, '0')}`
        });

    } catch (error) {
        if (conn) await conn.rollback();
        console.error('Fix all gaps error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fix gaps: ' + error.message
        });
    } finally {
        if (conn) await conn.end();
    }
});



// Call this in initializeDatabase() after creating tables
// Function to ensure invoice number is unique before using it
async function validateInvoiceNumber(invoiceNumber) {
    let conn;
    try {
        conn = await getDbConnection();

        // Check if this invoice number already exists in job_cards
        const existingJobCard = await conn.query(
            'SELECT id FROM job_cards WHERE invoice_no = ?',
            [invoiceNumber]
        );

        // Also check in invoices table
        const existingInvoice = await conn.query(
            'SELECT id FROM invoices WHERE invoice_no = ?',
            [invoiceNumber]
        );

        const exists = existingJobCard.length > 0 || existingInvoice.length > 0;

        if (exists) {
            console.warn(`⚠️ Invoice number ${invoiceNumber} already exists!`);
        }

        return !exists;

    } catch (error) {
        console.error('Validate invoice number error:', error);
        return true; // Assume it's valid if check fails
    } finally {
        if (conn) await conn.end();
    }
}


// First, install the required packages:
// npm install puppeteer handlebars fs-extra

// ==================== AUTHENTICATION MIDDLEWARE ====================
const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                error: 'Access token required'
            });
        }

        let conn;
        try {
            conn = await getDbConnection();

            // Find active session with token
            const sessions = await conn.query(
                `SELECT s.*, u.id as user_id, u.name, u.email, u.role, u.status 
                 FROM sessions s 
                 LEFT JOIN users u ON s.user_id = u.id 
                 WHERE s.token = ? AND s.is_active = TRUE AND s.expires_at > NOW()`,
                [token]
            );

            if (sessions.length === 0) {
                return res.status(401).json({
                    success: false,
                    error: 'Invalid or expired token'
                });
            }

            const session = sessions[0];

            // Check if user is active
            if (session.status !== 'active') {
                return res.status(403).json({
                    success: false,
                    error: 'User account is not active'
                });
            }

            // Update last activity
            await conn.query(
                'UPDATE sessions SET expires_at = DATE_ADD(NOW(), INTERVAL 2 HOUR) WHERE id = ?',
                [session.id]
            );

            // Attach user info to request
            req.user = {
                id: session.user_id,
                name: session.name,
                email: session.email,
                role: session.role,
                sessionId: session.id
            };

            next();

        } finally {
            if (conn) await conn.end();
        }

    } catch (error) {
        console.error('Authentication error:', error);
        res.status(500).json({
            success: false,
            error: 'Authentication failed'
        });
    }
};

// Optional: Role-based middleware
const authorizeRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                error: 'User not authenticated'
            });
        }

        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions'
            });
        }

        next();
    };
};

// Test without authentication first
app.get('/api/invoice/pdf/:invoice_number', async (req, res) => {
    try {
        const { invoice_number } = req.params;
        console.log(`Generating PDF for invoice: ${invoice_number}`);
        res.json({
            success: true,
            message: 'Route works!',
            invoice: invoice_number
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/invoice/pdf/:invoice_number', authenticateToken, async (req, res) => {
    try {
        const { invoice_number } = req.params;
        console.log(`Generating PDF for invoice: ${invoice_number}`);

        // Generate PDF
        const pdfBuffer = await generateInvoicePDF(invoice_number);

        // Log the action
        await logAudit(req.user.id, 'invoice_pdf_download', {
            invoice_number: invoice_number,
            downloaded_by: req.user.email,
            timestamp: new Date().toISOString()
        });

        // Set response headers for PDF download
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="invoice_${invoice_number}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);

        res.send(pdfBuffer);

    } catch (error) {
        console.error('PDF generation error:', error);

        // Log the error
        await logAudit(req.user.id, 'invoice_pdf_error', {
            invoice_number: req.params.invoice_number,
            error: error.message,
            timestamp: new Date().toISOString()
        });

        res.status(500).json({
            success: false,
            error: 'Failed to generate PDF',
            details: error.message
        });
    }
});

// Function to fetch invoice data from database
async function fetchInvoiceData(invoiceNumber) {
    const conn = await getDbConnection();

    try {
        // Fetch invoice details
        const invoiceQuery = `
            SELECT 
                i.*,
                
                c.company as customer_company,
                c.email as customer_email,
                c.phone as customer_phone,
                c.name as customer_name, c.address as customer_address,
                jc.*
            FROM invoices i
            LEFT JOIN customers c ON i.customer_id = c.id
            LEFT JOIN job_cards jc ON i.job_card_id = jc.id
            WHERE i.invoice_no = ?
        `;

        const [invoice] = await conn.query(invoiceQuery, [invoiceNumber]);

        if (!invoice) {
            throw new Error('Invoice not found');
        }

        // Fetch invoice charges
        const chargesQuery = `
            SELECT * FROM invoice_charges 
            WHERE invoice_id = ? 
            ORDER BY id
        `;

        const charges = await conn.query(chargesQuery, [invoice.id]);

        // Fetch advance payments
        const advanceQuery = `
            SELECT SUM(amount) as total_advance 
            FROM advance_payments 
            WHERE invoice_id = ?
        `;

        const [advanceResult] = await conn.query(advanceQuery, [invoice.id]);
        const totalAdvance = advanceResult?.total_advance || 0;

        // Calculate subtotal from charges
        const subtotal = charges.reduce((sum, charge) => {
            return sum + (parseFloat(charge.total_amount) || 0);
        }, 0);

        const invoiceTotal = parseFloat(invoice.total) || subtotal;
        const balance = Math.max(invoiceTotal - parseFloat(totalAdvance), 0);
        const creditsBalance = Math.max(parseFloat(totalAdvance) - invoiceTotal, 0);

        return {
            invoice: invoice,
            charges: charges,
            total_advance: totalAdvance,
            subtotal: subtotal,
            invoice_total: invoiceTotal,
            balance: balance,
            credits_balance: creditsBalance
        };

    } finally {
        await conn.end();
    }
}

// Helper function to format currency
function formatCurrency(value) {
    if (value === null || value === undefined) return "0.000";
    return parseFloat(value).toLocaleString('en-US', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3
    });
}

function numberToWords(num) {
    return amountToKwdWords(num);
}

// Function to generate PDF using Puppeteer
async function generateInvoicePDF(invoiceNumber) {
    const browser = await puppeteer.launch({
        headless: true,
        executablePath: getChromeExecutablePath(),
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        // Fetch invoice data
        const invoiceData = await fetchInvoiceData(invoiceNumber);

        // Generate HTML content
        const htmlContent = generateInvoiceHTML(invoiceData);

        const page = await browser.newPage();

        // Set content
        await page.setContent(htmlContent, {
            waitUntil: 'networkidle0'
        });

        // Generate PDF
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: {
                top: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
                right: '0.5in'
            }
        });

        return pdfBuffer;

    } finally {
        await browser.close();
    }
}


// Function to generate HTML content
function generateInvoiceHTML(data) {
    const invoice = data.invoice;
    const charges = data.charges;
    const totalAdvance = data.total_advance;
    const subtotal = data.subtotal;
    const balance = data.balance;

    // Generate charges rows
    let chargesRowsHTML = '';
    charges.forEach((charge, index) => {
        const topPosition = 26.9858 + (index * 1.0625);
        chargesRowsHTML += `
            <div class="pdf24_01" style="left:3.8025em;top:${topPosition}em;">
                <span class="pdf24_21 pdf24_08 pdf24_18">${index + 1}</span>
            </div>
            <div class="pdf24_01" style="left:6.08em;top:${topPosition}em;">
                <span class="pdf24_21 pdf24_08 pdf24_14" style="word-spacing:-0.0016em;">
                    ${(charge.description || charge.charge_type || '').toUpperCase()}
                </span>
            </div>
            <div class="pdf24_01" style="left:32.2325em;top:${topPosition}em;">
                <span class="pdf24_21 pdf24_08 pdf24_18">${formatCurrency(charge.quantity)}</span>
            </div>
            <div class="pdf24_01" style="left:36.6233em;top:${topPosition}em;">
                <span class="pdf24_21 pdf24_08 pdf24_15">${formatCurrency(charge.unit_amount)}</span>
            </div>
            <div class="pdf24_01" style="left:43.8658em;top:${topPosition}em;">
                <span class="pdf24_21 pdf24_08 pdf24_15">${formatCurrency(charge.total_amount)}</span>
            </div>
        `;
    });

    // Read and process the template HTML
    const templateHTML = fs.readFileSync(path.join(__dirname, 'invoice-template.html'), 'utf8');

    // Replace dynamic content using string replacement
    let finalHTML = templateHTML
        .replace('{{CUSTOMER_NAME}}', invoice.customer_name || '')
        .replace('{{CUSTOMER_COMPANY}}', invoice.customer_company || '')
        .replace('{{INVOICE_NUMBER}}', invoice.invoice_no || '')
        .replace('{{INVOICE_DATE}}', invoice.date ? new Date(invoice.date).toLocaleDateString('en-GB') : '')
        .replace('{{JOB_NUMBER}}', invoice.job_no || '')
        .replace('{{HBL_NUMBER}}', invoice.hbl || '')
        .replace('{{COMMERCIAL_INVOICE_NO}}', invoice.commercial_invoice_no || '')
        .replace('{{ETD_DATE}}', invoice.estd ? new Date(invoice.estd).toLocaleDateString('en-GB') : '')
        .replace('{{ETA_DATE}}', invoice.eta ? new Date(invoice.eta).toLocaleDateString('en-GB') : '')
        .replace('{{SHIPPER_NAME}}', invoice.shipper_name || '')
        .replace('{{SHIPPER_REF}}', invoice.shipper_ref_no || '')
        .replace('{{DEPARTURE_PORT}}', invoice.departure_location || '')
        .replace('{{ARRIVAL_PORT}}', invoice.arrival_location || '')
        .replace('{{COST_CENTER}}', invoice.cost_center || '')
        .replace('{{COST_CENTER_NUMBER}}', invoice.cost_center_number || '')
        .replace('{{REQUESTER_EMAIL}}', invoice.email || '')
        .replace('{{BAYAN_NUMBER}}', invoice.bayan_no || '')
        .replace('{{BAYAN_DATE}}', invoice.bayan_date ? new Date(invoice.bayan_date).toLocaleDateString('en-GB') : '')
        .replace('{{GROSS_WEIGHT}}', invoice.gross_weight ? `${formatCurrency(invoice.gross_weight)} kg` : '')
        .replace('{{CUSTOMER_REF}}', invoice.customer_ref_no || '')
        .replace('{{PACKAGES}}', invoice.packages || '')
        .replace('{{REQUESTER_NAME}}', invoice.requester_name || '')
        .replace('{{CHARGES_ROWS}}', chargesRowsHTML)
        .replace('{{SUBTOTAL}}', formatCurrency(subtotal))
        .replace('{{ADVANCE_PAYMENT}}', formatCurrency(totalAdvance))
        .replace('{{CREDITS_BALANCE}}', formatCurrency(data.credits_balance))
        .replace('{{BALANCE}}', formatCurrency(balance))
        .replace('{{AMOUNT_IN_WORDS}}', numberToWords(data.invoice_total));

    return finalHTML;
}

// Public preview endpoint (optional, remove authenticateToken if you want it public)
app.get('/api/invoice/preview/:invoice_number', async (req, res) => {
    try {
        const { invoice_number } = req.params;
        const invoiceData = await fetchInvoiceData(invoice_number);

        // Return JSON data for preview
        res.json({
            success: true,
            data: invoiceData
        });

    } catch (error) {
        console.error('Preview error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch invoice data',
            details: error.message
        });
    }
});

// Optional: Endpoint to generate and save PDF to server
app.post('/api/invoice/generate-pdf/:invoice_number', authenticateToken, authorizeRole('admin', 'manager'), async (req, res) => {
    try {
        const { invoice_number } = req.params;

        // Generate PDF
        const pdfBuffer = await generateInvoicePDF(invoice_number);

        // Save to server
        const pdfDir = path.join(__dirname, 'generated_pdfs');
        if (!fs.existsSync(pdfDir)) {
            fs.mkdirSync(pdfDir, { recursive: true });
        }

        const filePath = path.join(pdfDir, `invoice_${invoice_number}.pdf`);
        await fs.writeFile(filePath, pdfBuffer);

        // Log the action
        await logAudit(req.user.id, 'invoice_pdf_saved', {
            invoice_number: invoice_number,
            saved_by: req.user.email,
            file_path: filePath,
            timestamp: new Date().toISOString()
        });

        res.json({
            success: true,
            message: 'PDF generated and saved successfully',
            file_path: filePath,
            download_url: `/api/invoice/download-pdf/${invoice_number}`
        });

    } catch (error) {
        console.error('PDF save error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate and save PDF'
        });
    }
});




// Download saved PDF
app.get('/api/invoice/download-pdf/:invoice_number', authenticateToken, async (req, res) => {
    try {
        const { invoice_number } = req.params;
        const filePath = path.join(__dirname, 'generated_pdfs', `invoice_${invoice_number}.pdf`);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({
                success: false,
                error: 'PDF file not found'
            });
        }

        res.download(filePath, `invoice_${invoice_number}.pdf`);

    } catch (error) {
        console.error('PDF download error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to download PDF'
        });
    }
});

// Start the server
startServer();


