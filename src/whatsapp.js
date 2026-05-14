// Reusable function to send WhatsApp messages via Meta Graph API
// `credentials` = { phone_number_id, access_token }. Si no se pasan, usa env vars (legacy).
const resolveCreds = (credentials) => {
  const phone_number_id = credentials?.phone_number_id || process.env.PHONE_NUMBER_ID;
  const access_token    = credentials?.access_token    || process.env.WHATSAPP_TOKEN;
  if (!phone_number_id || !access_token) {
    throw new Error('WhatsApp credentials missing (phone_number_id / access_token).');
  }
  return { phone_number_id, access_token };
};

const sendMessage = async (to, text, credentials = null) => {
  const { phone_number_id, access_token } = resolveCreds(credentials);
  const url = `https://graph.facebook.com/v18.0/${phone_number_id}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text }
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Failed to send message:', response.status, response.statusText, errBody);
      throw new Error(`Send message failed: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error sending message:', error);
    throw error;
  }
};

const sendTemplateMessage = async (to, templateName, languageCode = 'es', credentials = null) => {
  const { phone_number_id, access_token } = resolveCreds(credentials);
  const url = `https://graph.facebook.com/v18.0/${phone_number_id}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name: templateName, language: { code: languageCode } }
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Failed to send template:', response.status, response.statusText, errBody);
      throw new Error(`Send template failed: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error sending template message:', error);
    throw error;
  }
};

module.exports = { sendMessage, sendTemplateMessage };
