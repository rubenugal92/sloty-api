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
    return result;
  } catch (error) {
    console.error('Error sending message:', error);
    throw error;
  }
};

// Function to send template messages (for future use with WhatsApp templates)
const sendTemplateMessage = async (to, templateName, languageCode = 'es') => {
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
        type: "template",
        template: {
          name: templateName,
          language: {
            code: languageCode
          }
        }
      })
    });

    if (!response.ok) {
      console.error('Failed to send template message:', response.status, response.statusText);
      throw new Error(`Send template message failed: ${response.statusText}`);
    }

    const result = await response.json();
    console.log('Template message sent:', result);
    return result;
  } catch (error) {
    console.error('Error sending template message:', error);
    throw error;
  }
};

module.exports = { sendMessage, sendTemplateMessage };