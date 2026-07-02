const crypto = require('crypto');

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const META_BASE_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
// Official Meta-hosted entry point used by the WhatsApp Business Platform Embedded Signup flow.
const META_OAUTH_URL = 'https://www.facebook.com/v21.0/dialog/oauth';

const buildMetaOAuthUrl = ({ clientId, redirectUri, state, scopes = ['whatsapp_business_management', 'whatsapp_business_messaging'] }) => {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope: scopes.join(','),
    auth_type: 'rerequest',
  });

  return `${META_OAUTH_URL}?${params.toString()}`;
};

const buildMetaOAuthState = ({ companyId, userId }) => {
  const nonce = crypto.randomBytes(8).toString('hex');
  return `whatsapp_oauth_${nonce}_company_${companyId}_user_${userId}`;
};

const parseMetaOAuthState = (state) => {
  const match = state?.match(/company_(\d+)_user_(\d+)/);
  if (!match) return {};

  return {
    companyId: parseInt(match[1], 10),
    userId: parseInt(match[2], 10),
  };
};

const requestJson = async (url, { method = 'GET', headers = {}, body } = {}) => {
  const response = await fetch(url, { method, headers, body });
  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = text;
    }
  }

  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `Meta request failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
};

const exchangeCodeForToken = async ({ code, redirectUri, clientId, clientSecret }) => {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });

  const url = `${META_BASE_URL}/oauth/access_token?${params.toString()}`;
  return requestJson(url);
};

const exchangeForLongLivedToken = async ({ clientId, clientSecret, shortLivedToken }) => {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: clientId,
    client_secret: clientSecret,
    fb_exchange_token: shortLivedToken,
  });

  const url = `${META_BASE_URL}/oauth/access_token?${params.toString()}`;
  return requestJson(url);
};

const getWhatsAppBusinessConfig = async (accessToken) => {
  const me = await requestJson(
    `${META_BASE_URL}/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`
  );

  return {
    meId: me?.id || null
  };
};

module.exports = {
  buildMetaOAuthUrl,
  buildMetaOAuthState,
  parseMetaOAuthState,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getWhatsAppBusinessConfig,
};
