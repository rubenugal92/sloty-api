// Reusable function to send WhatsApp messages via Meta Graph API
const sendMessage = async (to, text) => {
  const url = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: text }
      })
    });

    if (!response.ok) {
      console.error('Failed to send message:', response.status, response.statusText);
      throw new Error(`Send message failed: ${response.statusText}`);
    }

    const result = await response.json();
    console.log('Message sent:', result);
  } catch (error) {
    console.error('Error sending message:', error);
  }
};

module.exports = { sendMessage };