import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import nodemailer from "nodemailer";
import { v4 as uuidv4 } from "uuid";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));

// --- Types ---
interface SmtpServer {
  host: string;
  port: number;
  user: string;
  pass: string;
}

type JobStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed';

interface JobConfig {
  smtpServers: SmtpServer[];
  recipients: string[];
  template: string;
  subject: string;
  fromName: string;
  links: string[];
  images: string[];
  headersTemplate: string;
  delay: number;
}

interface EmailJob {
  id: string;
  status: JobStatus;
  total: number;
  sent: number;
  failed: number;
  currentIndex: number;
  currentSmtp?: string;
  currentLink?: string;
  currentImage?: string;
  startTime?: number;
  endTime?: number;
  logs: string[];
  config: JobConfig;
}

// In-memory job state (for production use a real DB or Redis)
const jobs: Record<string, EmailJob> = {};

// --- Gemini Setup ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// --- API Routes ---

// AI Content Generation
app.post("/api/ai/optimize", async (req, res) => {
  try {
    const { content, type } = req.body; // type: 'subject' | 'body'
    const prompt = type === 'subject' 
      ? `Optimize this email subject line to increase open rates. Keep it catchy but professional: "${content}"`
      : `Refine this email body content to be more engaging and persuasive, while preserving the variables like [F_Name], [Links], [images], [BND], [random_id], [Date]. Content: "${content}"`;

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    res.json({ optimized: response.text() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Test SMTP Connection
app.post("/api/smtp/test", async (req, res) => {
  const { host, port, user, pass } = req.body;
  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      tls: { rejectUnauthorized: false }
    });
    await transporter.verify();
    res.json({ success: true, message: "Connection successful" });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Start Mass Send Job
app.post("/api/jobs/start", async (req, res) => {
  const { 
    smtpServers, 
    recipients, 
    template, 
    subject, 
    fromName, 
    links, 
    images,
    headersTemplate,
    delay = 9000 
  } = req.body;

  const jobId = uuidv4();
  const config: JobConfig = { 
    smtpServers, 
    recipients, 
    template, 
    subject, 
    fromName, 
    links, 
    images, 
    headersTemplate, 
    delay 
  };
  
  jobs[jobId] = {
    id: jobId,
    status: 'running',
    total: recipients.length,
    sent: 0,
    failed: 0,
    currentIndex: 0,
    startTime: Date.now(),
    logs: [`🚀 Job initialized for ${recipients.length} recipients.`],
    config
  };

  // Run in background
  (async () => {
    const currentJob = jobs[jobId];
    
    while (currentJob.currentIndex < recipients.length) {
      const status = currentJob.status as JobStatus;
      if (status === 'idle') {
        currentJob.logs.push(`🛑 Job stopped by user.`);
        break;
      }

      if (status === 'paused') {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const idx = currentJob.currentIndex;
      const recipient = recipients[idx];
      const smtp = smtpServers[idx % smtpServers.length];
      const link = links[idx % links.length] || '';
      const image = images[idx % images.length] || '';
      
      currentJob.currentSmtp = smtp.user;
      currentJob.currentLink = link;
      currentJob.currentImage = image;

      const fName = recipient.split('@')[0];
      const randomId = Math.random().toString(36).substring(2, 11);
      const bnd = `BND_${uuidv4().substring(0, 8)}`;

      // --- Improved Replacement Engine ---
      
      const baseVars: Record<string, string> = {
        'F_Name': fName,
        'Links': link,
        'images': image,
        'Date': new Date().toUTCString(),
        'random_id': randomId,
        'BND': bnd,
        'To': recipient,
        'Cc': '',
        'sender_email': smtp.user,
      };

      const baseKeys = Object.keys(baseVars).join('|');
      const applyBase = (t: string) => t.replace(new RegExp(`\\[(${baseKeys})\\]`, 'g'), (m, k) => baseVars[k] || m);

      const derivedVars: Record<string, string> = {
        ...baseVars,
        'sender_name': applyBase(fromName || ''),
        'Subject': applyBase(subject || '')
      };

      const allKeys = Object.keys(derivedVars).join('|');
      const applyAll = (t: string) => t.replace(new RegExp(`\\[(${allKeys})\\]`, 'g'), (m, k) => derivedVars[k] || m);

      let pSubject = applyAll(subject || '');
      let pBody = applyAll(template || '');
      let pHeadersRaw = headersTemplate ? applyAll(headersTemplate) : '';

      try {
        const transporter = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.port === 465,
          auth: { user: smtp.user, pass: smtp.pass },
          tls: { rejectUnauthorized: false }
        });

        if (pHeadersRaw) {
          const rawSource = `${pHeadersRaw.trim()}\r\n\r\n${pBody}`;
          await transporter.sendMail({
            envelope: { from: smtp.user, to: recipient },
            raw: rawSource
          });
        } else {
          await transporter.sendMail({
            from: `"${derivedVars['sender_name']}" <${smtp.user}>`,
            to: recipient,
            subject: pSubject,
            html: pBody,
          });
        }

        currentJob.sent++;
        currentJob.logs.push(`✅ [${idx+1}/${recipients.length}] Sent to ${recipient}`);
      } catch (err: any) {
        currentJob.failed++;
        currentJob.logs.push(`❌ [${idx+1}/${recipients.length}] Failed for ${recipient}: ${err.message}`);
      }

      currentJob.currentIndex++;

      if (currentJob.currentIndex < recipients.length) {
        if (delay > 2000) {
          currentJob.logs.push(`⏳ Waiting ${delay/1000}s before next...`);
          const startWait = Date.now();
          while (Date.now() - startWait < delay) {
            if ((currentJob.status as JobStatus) === 'idle') break;
            await new Promise(r => setTimeout(r, 500));
          }
        } else if (delay > 0) {
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (currentJob.status !== 'idle') {
      currentJob.status = 'completed';
      currentJob.endTime = Date.now();
    }
    currentJob.logs.push(`🏁 Job finished. Sent: ${currentJob.sent}, Failed: ${currentJob.failed}`);
  })();

  res.json({ jobId });
});

// Get All Jobs (History)
app.get("/api/jobs", (req, res) => {
  res.json(Object.values(jobs).sort((a, b) => (b.startTime || 0) - (a.startTime || 0)));
});

// Get Job Progress
app.get("/api/jobs/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// Job Control Actions
app.post("/api/jobs/:id/:action", (req, res) => {
  const { id, action } = req.params;
  const job = jobs[id];
  if (!job) return res.status(404).json({ error: "Job not found" });

  if (action === 'stop') job.status = 'idle';
  if (action === 'pause') job.status = 'paused';
  if (action === 'resume') job.status = 'running';

  res.json({ success: true, status: job.status });
});

// --- Vite & Static Static Files ---
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
