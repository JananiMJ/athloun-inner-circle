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

const CompanyCode = mongoose.model('CompanyCode', companySchema, 'companycodes');
const Member = mongoose.model('Member', memberSchema, 'members');

// ===== GMAIL NODEMAILER SETUP =====
const transporter = nodemailer.createTransport({
  service: 'gmail',
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,          // your Gmail address
    pass: process.env.GMAIL_APP_PASSWORD   // Gmail app password
  }
});

// ===== ROUTES =====

// 1) Submit verification form – NO Shopify here
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

    const existingVerified = await Member.findOne({ work_email, verification_status: 'verified' });
    if (existingVerified) {
      return res.status(400).json({
        error: 'This email is already registered. Log in to your account to access your discount.'
      });
    }

    // Create verification token (24 hours)
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
      member.company_code = company_code;
      member.company_name = company.company_name;
      member.verification_token = verification_token;
      member.token_expires_at = token_expires_at;
      member.verification_status = 'pending';
    }
    await member.save();

    const verification_link =
      `${process.env.FRONTEND_URL}?token=${verification_token}&email=${encodeURIComponent(work_email)}`;

    // Send verification email via Gmail
    await transporter.sendMail({
      to: work_email,
      from: process.env.GMAIL_USER,
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
          </div>
        </div>
      `
    });

    return res.json({
      success: true,
      message: `Check your email! We sent a verification link to ${work_email}.`
    });
  console.log('Verification email sent to', work_email);
} catch (mailErr) {
  console.error('Email send error:', mailErr.message);
  console.error('Full mail error:', mailErr);
  return res.status(500).json({ error: 'Could not send verification email.' });
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
    const first_name = first_part.charAt(0).toUpperCase() + first_part.slice(1);
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

    // Create price rule
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

    return res.json({
      success: true,
      message: 'Email verified! Your discount code has been generated.',
      discount_code,
      first_name
    });
  } catch (error) {
    console.error('Verification error:', error.message);
    if (error.response) {
      console.error('Shopify status:', error.response.status);
      console.error('Shopify data:', error.response.data);
    }
    return res.status(500).json({ error: 'An error occurred during verification.' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
});
