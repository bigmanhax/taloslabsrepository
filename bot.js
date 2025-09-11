require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');

// Initialize bot and express
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const app = express();

// IMPORTANT: Webhook needs raw body, everything else needs JSON
app.use('/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Google Sheets setup
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
let sheet;

// Initialize Google Sheet
async function initSheet() {
  try {
    await doc.loadInfo();
    sheet = doc.sheetsByIndex[0]; // First sheet
    console.log('Google Sheet connected successfully');
  } catch (error) {
    console.error('Failed to connect to Google Sheet:', error);
  }
}

// Database functions using Google Sheets
async function getUser(telegramId) {
  try {
    const rows = await sheet.getRows();
    const userRow = rows.find(row => row.get('telegram_id') === telegramId.toString());
    if (userRow) {
      return {
        telegram_id: userRow.get('telegram_id'),
        telegram_username: userRow.get('telegram_username'),
        first_name: userRow.get('first_name'),
        stripe_customer_id: userRow.get('stripe_customer_id'),
        subscription_status: userRow.get('subscription_status'),
        subscription_end_date: userRow.get('subscription_end_date'),
        created_at: userRow.get('created_at')
      };
    }
    return null;
  } catch (error) {
    console.error('Error getting user:', error);
    return null;
  }
}

async function createUser(telegramId, username, firstName) {
  try {
    // Create Stripe customer
    const customer = await stripe.customers.create({
      metadata: {
        telegram_id: telegramId.toString(),
        telegram_username: username || 'no_username'
      },
      name: firstName
    });
    
    // Add to Google Sheet
    await sheet.addRow({
      telegram_id: telegramId.toString(),
      telegram_username: username || 'no_username',
      first_name: firstName || 'User',
      stripe_customer_id: customer.id,
      subscription_status: 'inactive',
      subscription_end_date: '',
      created_at: new Date().toISOString(),
      email: ''
    });
    
    return await getUser(telegramId);
  } catch (error) {
    console.error('Error creating user:', error);
    return null;
  }
}

async function updateUserSubscription(telegramId, status, endDate) {
  try {
    const rows = await sheet.getRows();
    const userRow = rows.find(row => row.get('telegram_id') === telegramId.toString());
    if (userRow) {
      userRow.set('subscription_status', status);
      userRow.set('subscription_end_date', endDate ? endDate.toISOString() : '');
      await userRow.save();
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error updating subscription:', error);
    return false;
  }
}

// Bot Commands

// Start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || 'User';
  const firstName = msg.from.first_name || 'Student';

  // Only respond to private messages
  if (msg.chat.type !== 'private') {
    return;
  }

  // Check/create user
  let user = await getUser(userId);
  if (!user) {
    user = await createUser(userId, username, firstName);
  }

  if (user && user.subscription_status === 'active') {
    const endDate = new Date(user.subscription_end_date).toLocaleDateString();
    const groupLink = await getPrivateGroupLink();
    bot.sendMessage(chatId, 
      `✅ *Active Subscription*\n\n` +
      `Valid until: ${endDate}\n\n` +
      `🔗 Access Premium Group:\n${groupLink}`,
      { parse_mode: 'Markdown' }
    );
  } else {
    const keyboard = {
      inline_keyboard: [[
        { text: '💳 Subscribe Now (€29.99/month)', callback_data: 'subscribe' }
      ]]
    };
    
    bot.sendMessage(chatId,
      `🎓 *Welcome to YourUniversity!*\n\n` +
      `Get unlimited access to:\n` +
      `✅ All premium courses\n` +
      `✅ Weekly live calls\n` +
      `✅ Private community\n` +
      `✅ Exclusive content\n\n` +
      `💰 Price: €29.99/month\n` +
      `❌ Cancel anytime`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }
});

// Status command
bot.onText(/\/status/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const user = await getUser(userId);
  
  if (!user) {
    bot.sendMessage(chatId, "No account found. Use /start to begin!");
    return;
  }
  
  if (user.subscription_status === 'active') {
    const endDate = new Date(user.subscription_end_date).toLocaleDateString();
    bot.sendMessage(chatId, 
      `✅ *Subscription Active*\n\n` +
      `Expires: ${endDate}\n` +
      `Auto-renewal: Enabled\n\n` +
      `Manage subscription: ${process.env.SERVER_URL}/portal/${user.stripe_customer_id}`,
      { parse_mode: 'Markdown' }
    );
  } else {
    bot.sendMessage(chatId, "❌ No active subscription. Use /start to subscribe!");
  }
});

// Handle subscription button click
bot.on('callback_query', async (query) => {
  if (query.data === 'subscribe') {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    
    bot.answerCallbackQuery(query.id, { text: 'Creating payment link...' });
    
    try {
      let user = await getUser(userId);
      if (!user) {
        user = await createUser(userId, query.from.username, query.from.first_name);
      }
      
      // Create Stripe checkout
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        customer: user.stripe_customer_id,
        line_items: [{
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1
        }],
        mode: 'subscription',
        success_url: `${process.env.SERVER_URL}/success`,
        cancel_url: `${process.env.SERVER_URL}/cancel`,
        metadata: {
          telegram_id: userId.toString(),
          telegram_username: query.from.username || 'unknown'
        }
      });
      
      const keyboard = {
        inline_keyboard: [[
          { text: '💳 Complete Payment', url: session.url }
        ]]
      };
      
      bot.sendMessage(chatId,
        `🔗 *Payment Link Ready!*\n\n` +
        `Click below to subscribe:\n\n` +
        `⏰ Link expires in 30 minutes`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
      
    } catch (error) {
      console.error('Checkout error:', error);
      bot.sendMessage(chatId, '❌ Error creating payment. Please try again.');
    }
  }
});

// Helper Functions
async function getPrivateGroupLink() {
  try {
    const link = await bot.exportChatInviteLink(process.env.PRIVATE_GROUP_ID);
    return link;
  } catch (error) {
    console.error('Error getting group link:', error);
    return 'Contact support for group access';
  }
}

// Stripe Webhook Handler
app.post('/stripe-webhook', async (req, res) => {
  console.log('Webhook received');
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    console.log('Event type:', event.type);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle events
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      const telegramId = session.metadata.telegram_id;
      console.log('Processing payment for telegram_id:', telegramId);
      
      try {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const endDate = new Date(subscription.current_period_end * 1000);
        console.log('Subscription end date:', endDate);
        
        const updated = await updateUserSubscription(telegramId, 'active', endDate);
        console.log('User updated:', updated);
        
        const groupLink = await getPrivateGroupLink();
        console.log('Group link generated:', groupLink);
        
        await bot.sendMessage(telegramId,
          `✅ *Payment Successful!*\n\n` +
          `Subscription active until: ${endDate.toLocaleDateString()}\n\n` +
          `🔗 *Join Premium Group:*\n${groupLink}\n\n` +
          `Save this link!`,
          { parse_mode: 'Markdown' }
        );
        console.log('Message sent to user');
      } catch (error) {
        console.error('Error processing payment:', error);
      }
      break;
      
    case 'customer.subscription.deleted':
      const cancelledSub = event.data.object;
      try {
        const customer = await stripe.customers.retrieve(cancelledSub.customer);
        const userTelegramId = customer.metadata.telegram_id;
        
        await updateUserSubscription(userTelegramId, 'cancelled', null);
        
        try {
          await bot.banChatMember(process.env.PRIVATE_GROUP_ID, userTelegramId);
          await bot.unbanChatMember(process.env.PRIVATE_GROUP_ID, userTelegramId);
        } catch (error) {
          console.error('Could not remove from group:', error);
        }
        
        await bot.sendMessage(userTelegramId,
          `❌ Subscription cancelled.\n\n` +
          `You've been removed from the premium group.\n` +
          `Use /start to subscribe again.`
        );
      } catch (error) {
        console.error('Error handling cancellation:', error);
      }
      break;
      
    case 'invoice.payment_failed':
      const invoice = event.data.object;
      try {
        const failedCustomer = await stripe.customers.retrieve(invoice.customer);
        const failedTelegramId = failedCustomer.metadata.telegram_id;
        
        await bot.sendMessage(failedTelegramId,
          `⚠️ *Payment Failed*\n\n` +
          `Update your payment method:\n` +
          `${process.env.SERVER_URL}/portal/${invoice.customer}\n\n` +
          `You have 3 days before losing access.`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('Error handling failed payment:', error);
      }
      break;
  }

  res.json({received: true});
});

// Web Pages
app.get('/success', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Success!</title>
      <style>
        body { 
          font-family: Arial; 
          text-align: center; 
          padding: 50px;
          background: #f0f0f0;
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 10px;
          max-width: 500px;
          margin: 0 auto;
        }
        h1 { color: #4CAF50; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>✅ Payment Successful!</h1>
        <p>Check Telegram for your private group link.</p>
        <p>You can close this window.</p>
      </div>
    </body>
    </html>
  `);
});

app.get('/cancel', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Cancelled</title>
      <style>
        body { 
          font-family: Arial; 
          text-align: center; 
          padding: 50px;
          background: #f0f0f0;
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 10px;
          max-width: 500px;
          margin: 0 auto;
        }
        h1 { color: #f44336; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Payment Cancelled</h1>
        <p>Return to Telegram to try again.</p>
      </div>
    </body>
    </html>
  `);
});

// Customer portal
app.get('/portal/:customerId', async (req, res) => {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: req.params.customerId,
      return_url: process.env.SERVER_URL
    });
    res.redirect(session.url);
  } catch (error) {
    res.send('Error accessing portal. Contact support.');
  }
});

// Video player with Telegram Mini App authentication
app.get('/video/:videoId', async (req, res) => {
  const videoId = req.params.videoId;
  
  // Send HTML with Telegram Web App authentication
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Video Player</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <script src="https://telegram.org/js/telegram-web-app.js"></script>
      <style>
        body { 
          margin: 0; 
          padding: 0; 
          background: #000;
          color: white;
          font-family: Arial, sans-serif;
        }
        #player { width: 100%; height: 100vh; }
        #loading { 
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          font-size: 20px;
        }
        #error {
          display: none;
          padding: 20px;
          text-align: center;
          color: #ff6b6b;
        }
      </style>
    </head>
    <body>
      <div id="loading">Loading video...</div>
      <div id="error"></div>
      <div id="player" style="display: none;"></div>
      
      <script src="https://player.vdocipher.com/v2/api.js"></script>
      <script>
        // Initialize Telegram Web App
        const tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand();
        
        // Get user data
        const initData = tg.initData;
        const user = tg.initDataUnsafe.user;
        
        if (!user) {
          document.getElementById('loading').style.display = 'none';
          document.getElementById('error').style.display = 'block';
          document.getElementById('error').innerHTML = 'Please open this link from Telegram';
        } else {
          // Verify subscription and load video
          fetch('/api/verify-and-get-video/${videoId}', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              initData: initData,
              userId: user.id
            })
          })
          .then(response => response.json())
          .then(data => {
            if (data.error) {
              document.getElementById('loading').style.display = 'none';
              document.getElementById('error').style.display = 'block';
              document.getElementById('error').innerHTML = data.error;
            } else {
              document.getElementById('loading').style.display = 'none';
              document.getElementById('player').style.display = 'block';
              
              // Initialize VdoCipher player
              const player = VdoPlayer.getInstance({
                otp: data.otp,
                playbackInfo: data.playbackInfo,
                theme: "9ae8bbe8dd964ddc9bdb932cca1cb59a",
                container: document.getElementById("player"),
              });
            }
          })
          .catch(error => {
            document.getElementById('loading').style.display = 'none';
            document.getElementById('error').style.display = 'block';
            document.getElementById('error').innerHTML = 'Error loading video';
          });
        }
      </script>
    </body>
    </html>
  `);
});

// API endpoint to verify subscription and get video OTP
app.post('/api/verify-and-get-video/:videoId', async (req, res) => {
  const videoId = req.params.videoId;
  const { userId } = req.body;
  
  try {
    // Verify subscription
    const user = await getUser(userId);
    if (!user || user.subscription_status !== 'active') {
      return res.json({ error: 'No active subscription. Please subscribe to access videos.' });
    }
    
    // Get VdoCipher OTP
    const response = await axios.post(
      `https://dev.vdocipher.com/api/videos/${videoId}/otp`,
      { ttl: 300 },
      {
        headers: {
          'Authorization': `Apisecret ${process.env.VDOCIPHER_API_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    const { otp, playbackInfo } = response.data;
    res.json({ otp, playbackInfo });
    
  } catch (error) {
    console.error('Video API error:', error);
    res.json({ error: 'Error loading video. Please try again.' });
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Bot is running!');
});

// Start server
async function start() {
  await initSheet();
  
  app.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
  });
  
  console.log('Bot is running...');
}

start();
