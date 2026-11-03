/**
 * Test-only SMTP stub.
 *
 * Speaks just enough of RFC 5321 for nodemailer to complete a delivery, so the
 * REAL provider path in utils/mailer.js can be exercised without credentials
 * and without any mail leaving the machine. Every accepted message body is
 * recorded so a test can assert what was actually transmitted.
 *
 * Shared by feature2-mailer-provider.test.js and feature4-language-otp.test.js
 * so both suites exercise the real send path without touching a network.
 */

import net from "node:net";

/**
 * Starts the stub on an ephemeral loopback port.
 * @returns {Promise<{port:number, state:{messages:string[], authAttempts:number}, close:() => Promise<void>}>}
 */
export function startSmtpStub() {
  const state = { messages: [], authAttempts: 0 };
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 twiller-stub ESMTP\r\n");
    let buffer = "";
    let inData = false;
    let dataLines = [];
    let authStep = 0;

    socket.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            state.messages.push(dataLines.join("\n"));
            dataLines = [];
            socket.write("250 2.0.0 Ok: queued as STUB1\r\n");
          } else {
            dataLines.push(line);
          }
          continue;
        }

        const cmd = (line.split(/\s+/)[0] || "").toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") {
          socket.write("250-twiller-stub\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n");
        } else if (cmd === "AUTH") {
          state.authAttempts += 1;
          const rest = line.replace(/^AUTH\s+/i, "");
          if (/^LOGIN/i.test(rest)) {
            authStep = 1;
            socket.write("334 VXNlcm5hbWU6\r\n");
          } else if (/^PLAIN$/i.test(rest)) {
            authStep = 3;
            socket.write("334 \r\n");
          } else {
            socket.write("235 2.7.0 Authentication successful\r\n");
          }
        } else if (authStep === 1) {
          authStep = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
        } else if (authStep === 2 || authStep === 3) {
          authStep = 0;
          socket.write("235 2.7.0 Authentication successful\r\n");
        } else if (cmd === "MAIL") {
          socket.write("250 2.1.0 Ok\r\n");
        } else if (cmd === "RCPT") {
          socket.write("250 2.1.5 Ok\r\n");
        } else if (cmd === "DATA") {
          inData = true;
          dataLines = [];
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (cmd === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 2.0.0 Ok\r\n");
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** A port that is guaranteed to have nothing listening on it (refused connect). */
export function closedPort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export default { startSmtpStub, closedPort };
