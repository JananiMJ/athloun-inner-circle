const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✓ MongoDB connected'))
.catch(err => console.error('✗ MongoDB error:', err));

// ===== DATABASE SCHEMAS =====

// Company Codes Schema
const companySchema = new mongoose.Schema({
  company_code: { type: String, unique: true, required: true },
  company_name: String,
  allowed_domain: String,
  active: { type: Boolean, default: true },
  created_at: { type: Date, default: Date.now },
  expires_at: Date,
  max_activations: Number,
  current_activations: { type: Number, default: 0 }
});
// Verified Insiders Schema
const memberSchema = new mongoose.Schema({
  work_email: { type: String, unique: true, required: true },
  company_code: String,
  company_name: String,
  shopify_customer_id: String,
  discount_code: String,
  verification_token: String,
  token_expires_at: Date,
  verified_at: Date,
  first_name: String,
  last_name: String,
  verification_status: { type: String, enum: ['pending', 'verified'], default: 'pending' },
  created_at: { type: Date, default: Date.now },
  first_purchase_at: Date,
  total_orders: { type: Number, default: 0 },
  total_spent: { type: Number, default: 0 }
});

const CompanyCode = mongoose.model('CompanyCode', companySchema, 'company_codes');
const Member = mongoose.model('Member', memberSchema);


// ===== EMAIL SETUP =====
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== API ROUTES =====

// 1. SUBMIT VERIFICATION FORM
app.post('/api/verify-form', async (req, res) => {
  try {
    const { company_code, work_email } = req.body;

    // Validate inputs
    if (!company_code || !work_email) {
      return res.status(400).json({ error: 'All fields required' });
    }

    // Check if company code exists and is active
    const company = await CompanyCode.findOne({ company_code, active: true });
    if (!company) {
      return res.status(400).json({ 
        error: 'Invalid code. Please check your Inner Circle card and try again.' 
      });
    }

    // Check if code is expired
    if (company.expires_at && new Date() > company.expires_at) {
      return res.status(400).json({ 
        error: 'This Insider program is no longer active. Contact support for assistance.' 
      });
    }

    // Check if max activations reached
    if (company.max_activations && company.current_activations >= company.max_activations) {
      return res.status(400).json({ 
        error: 'This company code has reached its activation limit.' 
      });
    }

    // Extract email domain
    const email_domain = work_email.split('@')[1];

    // Check if email domain matches company
    if (email_domain !== company.allowed_domain) {
      return res.status(400).json({ 
        error: `This email domain is not eligible. Use your @${company.allowed_domain} work email.` 
      });
    }

    // Check if email already verified
    const existing = await Member.findOne({ work_email, verification_status: 'verified' });
    if (existing) {
      return res.status(400).json({ 
        error: 'This email is already registered. Log in to your account to access your discount.' 
      });
    }

    // Generate verification token (24 hours validity)
    const verification_token = crypto.randomBytes(32).toString('hex');
    const token_expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Create/Update member record
    let member = await Member.findOne({ work_email });
    if (!member) {
      member = new Member({
        work_email,
        company_code,
        company_name: company.company_name,
        verification_token,
        token_expires_at,
        verification_status: 'pending'
      });
    } else {
      member.verification_token = verification_token;
      member.token_expires_at = token_expires_at;
      member.verification_status = 'pending';
    }

    await member.save();

    // Send verification email
    const verification_link = `${process.env.FRONTEND_URL}/insider/verify?token=${verification_token}&email=${encodeURIComponent(work_email)}`;

    const msg = {
      to: work_email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: 'Verify Your ATHLOUN Inner Circle Access',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #f4a460 0%, #cd853f 100%); padding: 30px; text-align: center; color: white;">
            <h1 style="margin: 0;">Welcome to ATHLOUN Inner Circle</h1>
          </div>
          <div style="padding: 30px; background: #f9f9f9;">
            <h2>Verify Your Access</h2>
            <p>Click the button below to verify your email and activate your 15% discount:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${verification_link}" style="background: #cd853f; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;">Verify Email</a>
            </div>
            <p style="color: #666; font-size: 12px;">This link expires in 24 hours.</p>
            <p style="color: #666; font-size: 12px;">Questions? Contact support@athloun.com</p>
          </div>
        </div>
      `
    };

    await sgMail.send(msg);

    res.json({ 
      success: true, 
      message: `Check your email! We sent a verification link to ${work_email}.` 
    });

  } catch (error) {
    console.error('Form submission error:', error);
    res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
});

// 2. VERIFY EMAIL TOKEN & CREATE ACCOUNT
app.get('/api/verify-email', async (req, res) => {
  try {
    const { token, email } = req.query;

    // Find member with valid token
    const member = await Member.findOne({
      work_email: email,
      verification_token: token,
      token_expires_at: { $gt: new Date() },
      verification_status: 'pending'
    });

    if (!member) {
      return res.status(400).json({ 
        error: 'Verification link expired. Please request a new verification email.' 
      });
    }

    // Generate unique discount code
    const first_name = email.split('@')[0].charAt(0).toUpperCase() + email.split('@')[0].slice(1);
    const random_code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const discount_code = `INNERCIRCLE-${first_name.toUpperCase()}-${random_code}`;

    // Create Shopify customer account
    const shopify_api = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01`;
    const shopify_headers = {
      'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN,
      'Content-Type': 'application/json'
    };

    // Check if customer exists
    let customer_response = await axios.get(
      `${shopify_api}/customers/search.json?query=email:${email}`,
      { headers: shopify_headers }
    ).catch(err => ({ data: { customers: [] } }));

    let shopify_customer_id;

    if (customer_response.data.customers.length > 0) {
      shopify_customer_id = customer_response.data.customers[0].id;
    } else {
      // Create new customer
      const create_customer = await axios.post(
        `${shopify_api}/customers.json`,
        {
          customer: {
            email: email,
            first_name: first_name,
            verified_email: true
          }
        },
        { headers: shopify_headers }
      );
      shopify_customer_id = create_customer.data.customer.id;
    }

    // Create discount code in Shopify
    const price_rule = await axios.post(
      `${shopify_api}/price_rules.json`,
      {
        price_rule: {
          title: `Inner Circle - ${first_name}`,
          target_type: 'line_item',
          target_selection: 'all',
          allocation_method: 'across',
          value: -15,
          value_type: 'percentage',
          customer_selection: 'all',
          starts_at: new Date().toISOString(),
          usage_limit: null,
          once_per_customer: false
        }
      },
      { headers: shopify_headers }
    );

    const price_rule_id = price_rule.data.price_rule.id;

    // Create discount code
    await axios.post(
      `${shopify_api}/price_rules/${price_rule_id}/discount_codes.json`,
      {
        discount_code: {
          code: discount_code
        }
      },
      { headers: shopify_headers }
    );

    // Update member
    member.shopify_customer_id = shopify_customer_id;
    member.discount_code = discount_code;
    member.verification_status = 'verified';
    member.verified_at = new Date();
    member.verification_token = null;
    member.token_expires_at = null;
    await member.save();

    // Update company activation count
    await CompanyCode.updateOne(
      { company_code: member.company_code },
      { $inc: { current_activations: 1 } }
    );

    // Send confirmation email
    const confirm_msg = {
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: 'Your ATHLOUN Inner Circle Discount Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #f4a460 0%, #cd853f 100%); padding: 30px; text-align: center; color: white;">
            <h1 style="margin: 0;">✓ Email Verified!</h1>
          </div>
          <div style="padding: 30px; background: #f9f9f9;">
            <h2>Welcome to ATHLOUN Inner Circle, ${first_name}!</h2>
            <p>Your 15% discount is ready! Here's your exclusive code:</p>
            
            <div style="background: white; border: 3px solid #cd853f; padding: 20px; text-align: center; margin: 20px 0; border-radius: 4px;">
              <p style="margin: 0 0 10px 0; color: #666; font-size: 12px;">Your Discount Code:</p>
              <h1 style="margin: 0; color: #cd853f; letter-spacing: 2px;">${discount_code}</h1>
            </div>

            <h3>Your Benefits:</h3>
            <ul>
              <li>15% OFF all purchases</li>
              <li>Free shipping</li>
              <li>Early access to new collections</li>
              <li>Lifetime discount - never expires</li>
            </ul>

            <p style="margin-top: 20px;">Ready to shop? <a href="${process.env.SHOPIFY_DOMAIN}" style="color: #cd853f; text-decoration: none; font-weight: bold;">Start shopping now</a></p>

            <p style="color: #666; font-size: 12px;">Note: COD orders are not eligible for discount.</p>
          </div>
        </div>
      `
    };

    await sgMail.send(confirm_msg);

    res.json({
      success: true,
      message: 'Email verified! Your discount code has been generated.',
      discount_code: discount_code,
      first_name: first_name
    });

  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'An error occurred during verification.' });
  }
});

// 3. ADMIN: Add Company Code
app.post('/api/admin/company-codes', async (req, res) => {
  try {
    // Check admin password
    if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { company_code, company_name, allowed_domain, expires_at, max_activations } = req.body;

    const new_company = new CompanyCode({
      company_code,
      company_name,
      allowed_domain,
      expires_at: expires_at ? new Date(expires_at) : null,
      max_activations: max_activations || null
    });

    await new_company.save();

    res.json({ 
      success: true, 
      message: `Company code ${company_code} created successfully` 
    });

  } catch (error) {
    res.status(500).json({ error: 'Error creating company code' });
  }
});

// 4. ADMIN: Get Dashboard Stats
app.get('/api/admin/stats', async (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const total_verifications = await Member.countDocuments({ verification_status: 'verified' });
    const pending_verifications = await Member.countDocuments({ verification_status: 'pending' });
    const companies = await CompanyCode.find();

    res.json({
      total_verifications,
      pending_verifications,
      companies: companies.map(c => ({
        code: c.company_code,
        name: c.company_name,
        activations: c.current_activations,
        max: c.max_activations
      }))
    });

  } catch (error) {
    res.status(500).json({ error: 'Error fetching stats' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
});
