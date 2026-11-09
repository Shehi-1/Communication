class SmsConfigurationError extends Error {}
class SmsDeliveryError extends Error {}

function createTwilioSmsProvider({
  accountSid = process.env.TWILIO_ACCOUNT_SID,
  authToken = process.env.TWILIO_AUTH_TOKEN,
  fromNumber = process.env.TWILIO_FROM_NUMBER
} = {}) {
  return {
    async sendVerificationCode(phoneNumber, code) {
      if (!accountSid || !authToken || !fromNumber) {
        throw new SmsConfigurationError("SMS provider is not configured.");
      }

      const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
      const body = new URLSearchParams({
        To: phoneNumber,
        From: fromNumber,
        Body: `Your Closeby verification code is ${code}. It expires in 10 minutes.`
      });
      let response;
      try {
        response = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${credentials}`,
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body
          }
        );
      } catch {
        throw new SmsDeliveryError("SMS provider is unavailable.");
      }

      if (!response.ok) throw new SmsDeliveryError("SMS delivery failed.");
    }
  };
}

module.exports = {
  SmsConfigurationError,
  SmsDeliveryError,
  createTwilioSmsProvider
};
