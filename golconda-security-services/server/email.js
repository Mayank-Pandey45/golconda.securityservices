export async function sendEmail({ from = process.env.EMAIL_FROM, to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !from) {
    const error = new Error("Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM.");
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = new Error(`Email provider returned HTTP ${response.status}.`);
    error.code = "EMAIL_PROVIDER_ERROR";
    throw error;
  }
  return response.json();
}
