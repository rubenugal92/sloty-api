const crypto = require('crypto');

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const META_BASE_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const META_OAUTH_URL = 'https://www.facebook.com/v21.0/dialog/oauth';

const buildMetaOAuthUrl = ({ clientId, redirectUri, state, scopes = ['business_management', 'whatsapp_business_management', 'whatsapp_business_messaging'] }) => {
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
  const me = await requestJson(`${META_BASE_URL}/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`);
  const businessesPayload = await requestJson(`${META_BASE_URL}/me/businesses?fields=id,name,timezone_id&access_token=${encodeURIComponent(accessToken)}`);
  const business = businessesPayload?.data?.[0] || null;

  let whatsappBusinessAccount = null;
  let phoneNumber = null;

  if (business?.id) {
    const accountsPayload = await requestJson(`${META_BASE_URL}/${business.id}/whatsapp_business_accounts?fields=id,name,timezone_id&access_token=${encodeURIComponent(accessToken)}`);
    whatsappBusinessAccount = accountsPayload?.data?.[0] || null;
  }

  if (whatsappBusinessAccount?.id) {
    const phoneNumbersPayload = await requestJson(`${META_BASE_URL}/${whatsappBusinessAccount.id}/phone_numbers?fields=id,display_phone_number,verified_name&access_token=${encodeURIComponent(accessToken)}`);
    phoneNumber = phoneNumbersPayload?.data?.[0] || null;
  }

  return {
    meId: me?.id || null,
    businessId: business?.id || null,
    businessName: business?.name || null,
    whatsappBusinessAccountId: whatsappBusinessAccount?.id || null,
    displayNumber: phoneNumber?.display_phone_number || null,
    phoneNumberId: phoneNumber?.id || null,
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
