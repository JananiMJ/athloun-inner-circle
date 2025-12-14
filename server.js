const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const nodemailer = require('nodemailer');

require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✓ MongoDB connected'))
  .catch(err => console.error('✗ MongoDB error:', err));

// ===== SCHEMAS =====
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

// Explicit collection names – you chose `companycodes`
const CompanyCode = mongoose.model('CompanyCode', companySchema, 'companycodes');
const Member = mongoose.model('Member', memberSchema, 'members');

// ===== SENDGRID =====
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// ===== ROUTES =====

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// 1) Submit verification form
app.post('/api/verify-form', async (req, res) => {
  try {
    const { company_code, work_email } = req.body;

    if (!company_code || !work_email) {
      return res.status(400).json({ error: 'All fields required' });
    }

    const company = await CompanyCode.findOne({ company_code, active: true });
    if (!company) {
      return res.status(400).json({
        error: 'Invalid code. Please check your Inner Circle card and try again.'
      });
    }

    if (company.expires_at && new Date() > company.expires_at) {
      return res.status(400).json({
        error: 'This Insider program is no longer active. Contact support for assistance.'
      });
    }

    if (company.max_activations && company.current_activations >= company.max_activations) {
      return res.status(400).json({
        error: 'This company code has reached its activation limit.'
      });
    }

    const email_domain = work_email.split('@')[1];
    if (email_domain !== company.allowed_domain) {
      return res.status(400).json({
        error: `This email domain is not eligible. Use your @${company.allowed_domain} work email.`
      });
    }

    const existing = await Member.findOne({ work_email, verification_status: 'verified' });
    if (existing) {
      return res.status(400).json({
        error: 'This email is already registered. Log in to your account to access your discount.'
      });
    }

    const verification_token = crypto.randomBytes(32).toString('hex');
    const token_expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000);

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

    const verification_link =
      `${process.env.FRONTEND_URL}/pages/insider?token=${verification_token}&email=${encodeURIComponent(work_email)}`;

    const msg = {
      to: work_email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: 'Verify Your ATHLOUN Inner Circle Access',
      html: `
        <p>Click the button below to verify your email and activate your 15% discount:</p>
        <p><a href="${verification_link}">Verify Email</a></p>
        <p>This link expires in 24 hours.</p>
      `
    };

    await transporter.sendMail({
  from: process.env.GMAIL_USER,
  to: work_email,
  subject: 'Verify Your ATHLOUN Inner Circle Access',
  html: `
    <p>Click the button below to verify your email and activate your 15% discount:</p>
    <p><a href="${verification_link}">Verify Email</a></p>
    <p>This link expires in 24 hours.</p>
  `
});


    res.json({
      success: true,
      message: `Check your email! We sent a verification link to ${work_email}.`
    });
  } catch (error) {
  console.error('Form submission error:', error);
  res.status(500).json({ error: error.message || 'An error occurred. Please try again.' });
}

});

// 2) Verify email + create Shopify discount
app.get('/api/verify-email', async (req, res) => {
  try {
    const { token, email } = req.query;

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

    const first_part = email.split('@')[0];
    const first_name =
      first_part.charAt(0).toUpperCase() + first_part.slice(1);
    const random_code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const discount_code = `INNERCIRCLE-${first_name.toUpperCase()}-${random_code}`;

    const shopify_api = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01`;
    const shopify_headers = {
      'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN,
      'Content-Type': 'application/json'
    };

    // Find or create customer
    let customer_response = await axios.get(
      `${shopify_api}/customers/search.json?query=email:${email}`,
      { headers: shopify_headers }
    ).catch(() => ({ data: { customers: [] } }));

    let shopify_customer_id;
    if (customer_response.data.customers.length > 0) {
      shopify_customer_id = customer_response.data.customers[0].id;
    } else {
      const create_customer = await axios.post(
        `${shopify_api}/customers.json`,
        {
          customer: {
            email,
            first_name,
            verified_email: true
          }
        },
        { headers: shopify_headers }
      );
      shopify_customer_id = create_customer.data.customer.id;
    }

    // Price rule
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

    await axios.post(
      `${shopify_api}/price_rules/${price_rule_id}/discount_codes.json`,
      { discount_code: { code: discount_code } },
      { headers: shopify_headers }
    );

    member.shopify_customer_id = shopify_customer_id;
    member.discount_code = discount_code;
    member.verification_status = 'verified';
    member.verified_at = new Date();
    member.verification_token = null;
    member.token_expires_at = null;
    await member.save();

    await CompanyCode.updateOne(
      { company_code: member.company_code },
      { $inc: { current_activations: 1 } }
    );

    // Confirmation email
    const confirm_msg = {
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: 'Your ATHLOUN Inner Circle Discount Code',
      html: `<p>Your code: <strong>${discount_code}</strong></p>`
    };
    
    await transporter.sendMail({
  from: process.env.GMAIL_USER,
  to: email,
  subject: 'Your ATHLOUN Inner Circle Discount Code',
  html: `<p>Your code: <strong>${discount_code}</strong></p>`
});

    res.json({
      success: true,
      message: 'Email verified! Your discount code has been generated.',
      discount_code,
      first_name
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'An error occurred during verification.' });
  }
});

// 3) Admin: create company code

app.post('/api/admin/company-codes', async (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const {
      company_code,
      company_name,
      allowed_domain,
      expires_at,
      max_activations
    } = req.body;

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
    console.error('Admin create code error:', error);
    res.status(500).json({ error: 'Error creating company code' });
  }
});

// 4) Admin: stats
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
    console.error('Admin stats error:', error);
    res.status(500).json({ error: 'Error fetching stats' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
});
