const axios = require('axios');

const shopify_api = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01`;
const shopify_headers = {
  'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN,
  'Content-Type': 'application/json'
};

async function testShopify() {
  try {
    console.log('Testing Shopify connection...');
    console.log('Store:', process.env.SHOPIFY_STORE);
    console.log('Token exists:', !!process.env.SHOPIFY_TOKEN);

    // Test 1: Search for a customer
    const test_email = 'test@example.com';
    const customer_response = await axios.get(
      `${shopify_api}/customers/search.json?query=email:${test_email}`,
      { headers: shopify_headers }
    );
    console.log('✓ Customer search works');

    // Test 2: Create a price rule
    const price_rule = await axios.post(
      `${shopify_api}/price_rules.json`,
      {
        price_rule: {
          title: 'Test Inner Circle',
          target_type: 'line_item',
          target_selection: 'all',
          allocation_method: 'across',
          value: -15,
          value_type: 'percentage',
          customer_selection: 'all',
          starts_at: new Date().toISOString()
        }
      },
      { headers: shopify_headers }
    );
    console.log('✓ Price rule creation works');
    console.log('Price Rule ID:', price_rule.data.price_rule.id);

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

testShopify();
