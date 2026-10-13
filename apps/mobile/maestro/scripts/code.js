// The newest 6-digit code emailed to TO, from Mailpit (Maestro's GraalJS: http, json).
const mailpit = MAILPIT_URL || "http://localhost:58025";
const search = json(
  http.get(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${TO}"`)}`).body,
);
const message = json(http.get(`${mailpit}/api/v1/message/${search.messages[0].ID}`).body);
output.code = /\b(\d{6})\b/.exec(message.Text)[1];
