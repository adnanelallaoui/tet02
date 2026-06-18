/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Mail, 
  Server, 
  Users, 
  Type, 
  Send, 
  Play, 
  Square, 
  Plus, 
  Trash2, 
  CheckCircle2, 
  XCircle, 
  Loader2, 
  Sparkles, 
  ExternalLink,
  ChevronRight,
  Zap,
  Activity,
  History,
  Clock,
  RotateCcw,
  Eye,
  Upload
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';

// Firebase core imports
import { auth, db, googleProvider, OperationType, handleFirestoreError } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { collection, doc, setDoc, getDoc, getDocs, deleteDoc } from 'firebase/firestore';

interface SmtpServer {
  host: string;
  port: number;
  user: string;
  pass: string;
}

interface JobState {
  id: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
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
  config?: any;
}

export default function App() {
  // --- Firebase Auth State ---
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authChecking, setAuthChecking] = useState<boolean>(true);

  // --- State ---
  const [activeTab, setActiveTab] = useState<'smtp' | 'data' | 'template' | 'deploy' | 'history'>('history');
  
  // Configuration State
  const [smtpServers, setSmtpServers] = useState<SmtpServer[]>([
    { host: '', port: 587, user: '', pass: '' }
  ]);
  const [bulkSmtp, setBulkSmtp] = useState<string>('');
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [recipients, setRecipients] = useState<string>('');
  const [links, setLinks] = useState<string>('');
  const [images, setImages] = useState<string>('');
  
  // Template State
  const [subject, setSubject] = useState('Important Delivery Update for [F_Name]');
  const [fromName, setFromName] = useState('Mail Delivery System');
  const [headersTemplate, setHeadersTemplate] = useState(`Content-Type: multipart/related; boundary="[BND]"
To: [To]
Cc: [Cc]
Message-ID: <69b5e318.170a0220.107061.d362.[random_id]@mx.google.com>
Date: [Date]
From: [sender_name] <[sender_email]>
Subject: [Subject]`);
  const [body, setBody] = useState('<p>Hello [F_Name],</p>\n<p>Check this out: [Links]</p>\n<p>[images]</p>');
  const [sendSpeed, setSendSpeed] = useState<number>(0.1); // emails per second (0.1 means 1 every 10s)
  
  // File Upload / Parsing State
  const [isDragging, setIsDragging] = useState(false);
  const [csvStatus, setCsvStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  // Job State
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobState, setJobState] = useState<JobState | null>(null);
  const [isAiLoading, setIsAiLoading] = useState<boolean>(false);
  const [historyJobs, setHistoryJobs] = useState<JobState[]>([]);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [isPreviewOpen, setIsPreviewOpen] = useState<boolean>(false);
  const [previewTab, setPreviewTab] = useState<'render' | 'html' | 'headers'>('render');
  const [smtpSyncing, setSmtpSyncing] = useState<boolean>(false);
  const [templateSyncing, setTemplateSyncing] = useState<boolean>(false);

  const logsRef = useRef<HTMLDivElement>(null);

  // --- Auth & User Firestore Integration ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        await loadUserData(currentUser.uid);
      }
      setAuthChecking(false);
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("Login failed:", err);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      // Reset state to empty defaults on sign-out
      setSmtpServers([{ host: '', port: 587, user: '', pass: '' }]);
      setRecipients('');
      setLinks('');
      setImages('');
      setSubject('Important Delivery Update for [F_Name]');
      setFromName('Mail Delivery System');
      setBody('<p>Hello [F_Name],</p>\n<p>Check this out: [Links]</p>\n<p>[images]</p>');
      setHistoryJobs([]);
      setJobState(null);
      setActiveTab('history');
    } catch (err) {
      console.error("Signout failed:", err);
    }
  };

  const loadUserData = async (uid: string) => {
    try {
      const userRef = doc(db, 'users', uid);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const udata = userSnap.data();
        if (udata.config) {
          const cfg = udata.config;
          if (cfg.subject !== undefined) setSubject(cfg.subject);
          if (cfg.fromName !== undefined) setFromName(cfg.fromName);
          if (cfg.headersTemplate !== undefined) setHeadersTemplate(cfg.headersTemplate);
          if (cfg.body !== undefined) setBody(cfg.body);
          if (cfg.sendSpeed !== undefined) setSendSpeed(cfg.sendSpeed);
          if (cfg.recipients !== undefined) setRecipients(cfg.recipients);
          if (cfg.links !== undefined) setLinks(cfg.links);
          if (cfg.images !== undefined) setImages(cfg.images);
        }
      } else {
        // Initialize user document
        await setDoc(userRef, {
          email: auth.currentUser?.email || '',
          uid: uid,
          createdAt: Date.now(),
          config: {
            subject,
            fromName,
            headersTemplate,
            body,
            sendSpeed,
            recipients,
            links,
            images
          }
        });
      }

      // Load SMTP details from nested collection
      const smtpColl = collection(db, 'users', uid, 'smtp_nodes');
      const smtpSnap = await getDocs(smtpColl);
      if (!smtpSnap.empty) {
        const loadedSmtps: SmtpServer[] = [];
        smtpSnap.forEach((docSnap) => {
          const d = docSnap.data();
          loadedSmtps.push({
            host: d.host || '',
            port: d.port || 587,
            user: d.user || '',
            pass: d.pass || ''
          });
        });
        setSmtpServers(loadedSmtps);
      } else {
        // Store default node
        await setDoc(doc(db, 'users', uid, 'smtp_nodes', 'default_node'), {
          host: smtpServers[0]?.host || '',
          port: smtpServers[0]?.port || 587,
          user: smtpServers[0]?.user || '',
          pass: smtpServers[0]?.pass || '',
          ownerId: uid,
          createdAt: Date.now()
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `users/${uid}`);
    }
  };

  const saveSmtpClusterToCloud = async (currentSmtps: SmtpServer[]) => {
    if (!auth.currentUser) return;
    try {
      const uid = auth.currentUser.uid;
      const smtpColl = collection(db, 'users', uid, 'smtp_nodes');
      const snap = await getDocs(smtpColl);
      for (const d of snap.docs) {
        await deleteDoc(d.ref);
      }
      for (let i = 0; i < currentSmtps.length; i++) {
        const s = currentSmtps[i];
        const nodeId = `node_${i + 1}`;
        await setDoc(doc(db, 'users', uid, 'smtp_nodes', nodeId), {
          host: s.host,
          port: s.port,
          user: s.user,
          pass: s.pass,
          ownerId: uid,
          createdAt: Date.now()
        });
      }
      alert("SMTP Cluster securely synced to your cloud vault!");
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${auth.currentUser?.uid}/smtp_nodes`);
    }
  };

  const saveTemplateToCloud = async () => {
    if (!user) return;
    setTemplateSyncing(true);
    try {
      const userRef = doc(db, 'users', user.uid);
      await setDoc(userRef, {
        email: user.email || '',
        uid: user.uid,
        config: {
          subject,
          fromName,
          headersTemplate,
          body,
          sendSpeed,
          recipients,
          links,
          images
        }
      }, { merge: true });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
    } finally {
      setTemplateSyncing(false);
    }
  };

  const handleSyncSmtp = async () => {
    if (!user) return;
    setSmtpSyncing(true);
    await saveSmtpClusterToCloud(smtpServers);
    setSmtpSyncing(false);
  };

  // --- Effects ---
  useEffect(() => {
    let interval: any;
    if (activeJobId || (jobState && (jobState.status === 'running' || jobState.status === 'paused'))) {
      const jobIdToPoll = activeJobId || jobState?.id;
      interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/jobs/${jobIdToPoll}`);
          if (res.ok) {
            const data = await res.json();
            setJobState(data);

            // Sync running job state to Firestore for durability
            if (user && data) {
              const jobRef = doc(db, 'users', user.uid, 'jobs', jobIdToPoll);
              await setDoc(jobRef, {
                id: data.id,
                status: data.status,
                total: data.total,
                sent: data.sent,
                failed: data.failed,
                currentIndex: data.currentIndex,
                currentSmtp: data.currentSmtp || '',
                currentLink: data.currentLink || '',
                currentImage: data.currentImage || '',
                startTime: data.startTime || Date.now(),
                endTime: data.endTime || 0,
                logs: data.logs || [],
                ownerId: user.uid,
                createdAt: data.startTime || Date.now(),
                config: data.config || {}
              });
            }

            if (data.status === 'completed' || data.status === 'failed' || data.status === 'idle') {
              if (activeJobId) setActiveJobId(null);
              if (user) {
                fetchHistory();
              }
            }
          }
        } catch (err) {
          console.error("Polling error:", err);
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [activeJobId, jobState?.id, jobState?.status, user]);

  useEffect(() => {
    if (activeTab === 'history') {
      fetchHistory();
    }
  }, [activeTab, user]);

  const fetchHistory = async () => {
    if (!user) return;
    try {
      const jobsColl = collection(db, 'users', user.uid, 'jobs');
      const jobsSnap = await getDocs(jobsColl);
      if (!jobsSnap.empty) {
        const jobsList: JobState[] = [];
        jobsSnap.forEach(docSnap => {
          const d = docSnap.data();
          jobsList.push({
            id: d.id,
            status: d.status,
            total: d.total,
            sent: d.sent,
            failed: d.failed,
            currentIndex: d.currentIndex,
            currentSmtp: d.currentSmtp,
            currentLink: d.currentLink,
            currentImage: d.currentImage,
            startTime: d.startTime,
            endTime: d.endTime,
            logs: d.logs,
            config: d.config
          });
        });
        jobsList.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        setHistoryJobs(jobsList);
      } else {
        setHistoryJobs([]);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `users/${user.uid}/jobs`);
    }
  };

  useEffect(() => {
    if (autoScroll && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [jobState?.logs, autoScroll]);

  // --- Helpers ---
  const getPreviewContent = () => {
    const rawRecipients = recipients.split('\n').map(r => r.trim()).filter(Boolean);
    const rawLinks = links.split('\n').map(r => r.trim()).filter(Boolean);
    const rawImages = images.split('\n').map(r => r.trim()).filter(Boolean);

    const recipient = rawRecipients[0] || 'customer@example.com';
    const smtp = smtpServers[0] || { host: 'smtp.example.com', port: 587, user: 'delivery@relay.com', pass: '' };
    const link = rawLinks[0] || 'https://geniusmail.io/click-redirect';
    const image = rawImages[0] || 'https://geniusmail.io/assets/banner.png';

    const fName = recipient.split('@')[0];
    const randomId = Math.random().toString(36).substring(2, 11);
    const bnd = 'BND_ae39fbc2';

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

    const baseKeys = Object.keys(baseVars).length > 0 ? Object.keys(baseVars).join('|') : '';
    const applyBase = (t: string) => {
      if (!baseKeys) return t;
      return t.replace(new RegExp(`\\[(${baseKeys})\\]`, 'g'), (m, k) => baseVars[k] || m);
    };

    const pFromName = applyBase(fromName || '');
    const pSubject = applyBase(subject || '');

    const derivedVars: Record<string, string> = {
      ...baseVars,
      'sender_name': pFromName,
      'Subject': pSubject
    };

    const allKeys = Object.keys(derivedVars).join('|');
    const applyAll = (t: string) => t.replace(new RegExp(`\\[(${allKeys})\\]`, 'g'), (m, k) => derivedVars[k] || m);

    return {
      subject: applyAll(subject || ''),
      fromName: applyAll(fromName || ''),
      senderEmail: smtp.user,
      body: applyAll(body || ''),
      headers: headersTemplate ? applyAll(headersTemplate) : '',
      recipient
    };
  };

  const parseAndSetEmails = (text: string) => {
    // Robust email scanner across all rows/cols
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const foundEmails = text.match(emailRegex) || [];
    const uniqueEmails = Array.from(new Set(foundEmails.map(e => e.trim().toLowerCase())));
    
    if (uniqueEmails.length > 0) {
      setRecipients(uniqueEmails.join('\n'));
      setCsvStatus({
        type: 'success',
        message: `Imported ${uniqueEmails.length} unique emails from file!`
      });
      setTimeout(() => setCsvStatus(null), 6000);
    } else {
      setCsvStatus({
        type: 'error',
        message: "No valid email addresses found in this file."
      });
      setTimeout(() => setCsvStatus(null), 6000);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processFile(file);
  };

  const processFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      parseAndSetEmails(text);
    };
    reader.onerror = () => {
      setCsvStatus({ type: 'error', message: "Failed to read file." });
    };
    reader.readAsText(file);
  };

  const addSmtp = () => setSmtpServers([...smtpServers, { host: '', port: 587, user: '', pass: '' }]);
  const removeSmtp = (index: number) => setSmtpServers(smtpServers.filter((_, i) => i !== index));
  const updateSmtp = (index: number, field: keyof SmtpServer, value: string | number) => {
    const next = [...smtpServers];
    // @ts-ignore
    next[index][field] = value;
    setSmtpServers(next);
  };

  const handleBulkSmtpChange = (val: string) => {
    setBulkSmtp(val);
    const lines = val.split('\n').map(l => l.trim()).filter(Boolean);
    const parsed: SmtpServer[] = lines.map(line => {
      const parts = line.split(/\s+/);
      return {
        host: parts[0] || '',
        port: parseInt(parts[1]) || 587,
        user: parts[2] || '',
        pass: parts[3] || ''
      };
    }).filter(s => s.host && s.user);

    if (parsed.length > 0) {
      setSmtpServers(parsed);
    }
  };

  const optimizeContent = async (type: 'subject' | 'body') => {
    setIsAiLoading(true);
    try {
      const res = await fetch('/api/ai/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          content: type === 'subject' ? subject : body, 
          type 
        })
      });
      const data = await res.json();
      if (type === 'subject') setSubject(data.optimized);
      else setBody(data.optimized);
    } catch (err) {
      console.error("AI Error:", err);
    } finally {
      setIsAiLoading(false);
    }
  };

  const startJob = async () => {
    const rawRecipients = recipients.split('\n').map(r => r.trim()).filter(Boolean);
    const rawLinks = links.split('\n').map(r => r.trim()).filter(Boolean);
    const rawImages = images.split('\n').map(r => r.trim()).filter(Boolean);

    if (rawRecipients.length === 0 || smtpServers.some(s => !s.host)) {
      alert("Please provide SMTP details and at least one recipient.");
      return;
    }

    // Auto-save settings in Firestore
    await saveTemplateToCloud();

    const delayInMs = Math.round(1000 / sendSpeed);

    const res = await fetch('/api/jobs/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        smtpServers,
        recipients: rawRecipients,
        template: body,
        headersTemplate,
        subject,
        fromName,
        links: rawLinks,
        images: rawImages,
        delay: delayInMs
      })
    });
    
    if (res.ok) {
      const { jobId } = await res.json();
      setActiveJobId(jobId);
      setActiveTab('deploy');
    }
  };

  const stopJob = async () => {
    const id = activeJobId || jobState?.id;
    if (!id) return;
    await fetch(`/api/jobs/${id}/stop`, { method: 'POST' });
    if (activeJobId) setActiveJobId(null);
  };

  const pauseJob = async () => {
    const id = activeJobId || jobState?.id;
    if (!id) return;
    await fetch(`/api/jobs/${id}/pause`, { method: 'POST' });
  };

  const resumeJob = async () => {
    const id = activeJobId || jobState?.id;
    if (!id) return;
    await fetch(`/api/jobs/${id}/resume`, { method: 'POST' });
  };

  const resendJob = (job: JobState) => {
    if (!job.config) return;
    const { config } = job;
    setSmtpServers(config.smtpServers);
    setRecipients(config.recipients.join('\n'));
    setLinks(config.links.join('\n'));
    setImages(config.images.join('\n'));
    setSubject(config.subject);
    setFromName(config.fromName);
    setHeadersTemplate(config.headersTemplate);
    setBody(config.template);
    setActiveTab('template');
  };

  const viewJobDetails = (job: JobState) => {
    setJobState(job);
    setActiveTab('deploy');
  };

  const stopHistoricalJob = async (id: string) => {
    await fetch(`/api/jobs/${id}/stop`, { method: 'POST' });
    fetchHistory();
  };

  const calculateMetrics = () => {
    if (!jobState || !jobState.startTime) return null;
    const now = jobState.endTime || Date.now();
    const elapsedSeconds = Math.max(0, (now - jobState.startTime) / 1000);
    const sent = jobState.sent + jobState.failed;
    const speed = sent > 0 ? sent / (elapsedSeconds / 3600) : 0; // msgs per hour
    
    const remaining = jobState.total - sent;
    const timePerEmail = sent > 0 ? elapsedSeconds / sent : 0;
    const estimatedRemaining = remaining * timePerEmail;
    
    const formatTime = (seconds: number) => {
      if (!isFinite(seconds) || isNaN(seconds)) return '00:00:00';
      const s = Math.max(0, Math.floor(seconds));
      return new Date(s * 1000).toISOString().substr(11, 8);
    };
    
    return {
      elapsed: formatTime(elapsedSeconds),
      speed: Math.round(speed),
      eta: remaining > 0 ? formatTime(estimatedRemaining) : '00:00:00'
    };
  };

  const metrics = calculateMetrics();

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#080808] flex flex-col items-center justify-center text-white font-sans">
        <Loader2 className="w-8 h-8 text-[#00FF88] animate-spin" />
        <span className="text-xs font-mono uppercase tracking-[0.2em] text-[#00FF88]/40 mt-4 animate-pulse">Initializing Secure Vault...</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#080808] text-white flex flex-col items-center justify-center p-6 select-none font-sans relative overflow-hidden">
        {/* Decorative background glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full bg-[#00FF88]/5 blur-[120px] pointer-events-none"></div>

        <div className="max-w-md w-full bg-[#0d0d0d] border border-white/5 p-8 md:p-12 rounded-2xl relative z-10 text-center space-y-8 shadow-2xl">
          <div className="flex flex-col items-center space-y-4">
            <div className="p-4 bg-[#00FF88] rounded-2xl relative shadow-[0_0_30px_#00FF8822]">
              <Zap className="w-8 h-8 text-black fill-black" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-white">
                GENIUS<span className="text-[#00FF88]">MAIL</span>
              </h1>
              <span className="text-[10px] text-white/30 uppercase tracking-[0.25em] font-mono block mt-1">High-Performance Campaign Relay</span>
            </div>
          </div>

          <div className="space-y-2 text-white/60 text-sm leading-relaxed">
            <p className="text-white text-base font-semibold">Cloud Sync Vault Integrated</p>
            <p className="text-xs text-white/40 font-normal">
              Sign in with your Google Account to unlock secure Firestore SMTP vaulting, real-time cross-device status sync, and persistent campaign run archives.
            </p>
          </div>

          <button 
            type="button" 
            onClick={handleLogin}
            className="w-full py-4 bg-white text-black hover:bg-neutral-100 font-semibold text-xs uppercase tracking-widest rounded-xl transition-all duration-300 flex items-center justify-center gap-3 cursor-pointer shadow-lg hover:shadow-white/5 active:scale-[0.98]"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v3.92h6.61a5.672 5.672 0 01-2.45 3.71v3.08h3.96c2.31-2.13 3.63-5.26 3.63-8.64z"/>
              <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.96-3.08c-1.1.74-2.52 1.18-3.97 1.18-3.06 0-5.64-2.07-6.57-4.86H1.47v3.18C3.47 21.36 7.42 24 12 24z"/>
              <path fill="#FBBC05" d="M5.43 14.33A7.19 7.19 0 015 12c0-.82.14-1.63.43-2.33V6.49H1.47A11.97 11.97 0 000 12c0 2.05.52 4 1.47 5.72l3.96-3.39z"/>
              <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.42 0 3.47 2.64 1.47 6.49l3.96 3.18c.93-2.79 3.51-4.92 6.57-4.92z"/>
            </svg>
            Sign in with Google
          </button>

          <div className="border-t border-white/5 pt-4">
            <span className="text-[9px] text-white/25 uppercase tracking-wider font-mono">Secured by Attribute-Based ABAC Shield</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#080808] text-white/90 font-sans selection:bg-[#00FF88] selection:text-black">
      {/* --- Header / Navigation --- */}
      <header className="sticky top-0 z-50 bg-[#080808]/80 backdrop-blur-md border-b border-white/5 py-4">
        <div className="max-w-5xl mx-auto px-6 flex justify-between items-center">
          <div className="flex items-center gap-3">
             <div className="p-1.5 bg-[#00FF88] rounded-md">
                <Zap className="w-5 h-5 text-black fill-black" />
             </div>
             <div>
                <h1 className="text-lg font-bold tracking-tight text-white leading-none">
                  GENIUS<span className="text-[#00FF88]">MAIL</span>
                </h1>
                <span className="text-[9px] text-white/30 uppercase tracking-widest font-mono">Core v2.4.1</span>
             </div>
          </div>

          <nav className="flex gap-1 bg-white/5 p-1 rounded-lg border border-white/5">
             <TopNavBtn icon={<Server className="w-4 h-4"/>} label="SMTP" active={activeTab === 'smtp'} onClick={() => setActiveTab('smtp')} />
             <TopNavBtn icon={<Users className="w-4 h-4"/>} label="Data" active={activeTab === 'data'} onClick={() => setActiveTab('data')} />
             <TopNavBtn icon={<Type className="w-4 h-4"/>} label="Payload" active={activeTab === 'template'} onClick={() => setActiveTab('template')} />
             <TopNavBtn icon={<History className="w-4 h-4"/>} label="Archive" active={activeTab === 'history'} onClick={() => setActiveTab('history')} />
             <TopNavBtn icon={<Activity className="w-4 h-4"/>} label="Live" active={activeTab === 'deploy'} onClick={() => setActiveTab('deploy')} />
          </nav>

          <div className="flex items-center gap-6">
            <div className="hidden md:flex flex-col text-right">
               <span className="text-[9px] uppercase text-white/30 tracking-widest font-mono">User Session</span>
               <div className="flex items-center gap-2 justify-end">
                 <span className="text-[10px] font-mono text-[#00FF88] truncate max-w-[120px]">{user?.email}</span>
                 <button 
                   onClick={handleLogout}
                   className="text-[9px] font-mono text-red-400 hover:text-red-300 uppercase tracking-wider font-bold"
                 >
                   [Sign Out]
                 </button>
               </div>
            </div>

            <div className="hidden md:flex flex-col text-right border-l border-white/10 pl-4">
               <span className="text-[9px] uppercase text-white/30 tracking-widest font-mono">Engine Status</span>
               <span className={cn(
                 "text-[10px] font-mono flex items-center gap-2 justify-end uppercase font-bold",
                 activeJobId || jobState?.status === 'running' ? "text-[#00FF88]" : jobState?.status === 'paused' ? "text-yellow-500" : "text-white/40"
               )}>
                 {(activeJobId || jobState?.status === 'running') ? (
                   <>
                     <span className="w-1 h-1 rounded-full bg-[#00FF88] animate-pulse"></span>
                     Active
                   </>
                 ) : jobState?.status || "Standby"}
               </span>
            </div>
          </div>
        </div>
      </header>

      {/* --- Main Content --- */}
      <main className="max-w-4xl mx-auto p-6 md:p-12 min-h-[calc(100vh-80px)] flex flex-col">
        <div className="flex-grow">
          <AnimatePresence mode="wait">
            {activeTab === 'smtp' && (
              <motion.section 
                key="smtp"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-3xl mx-auto space-y-8"
              >
                <div className="text-center space-y-2 mb-4">
                   <h2 className="text-xl font-bold tracking-tight">SMTP Infrastructure</h2>
                   <p className="text-[11px] font-mono text-white/30 uppercase tracking-[0.2em]">Configure your relay nodes</p>
                </div>

                <div className="flex justify-between items-end border-b border-white/10 pb-4">
                  <div className="flex items-center gap-6">
                    <h2 className="text-xs font-mono uppercase tracking-widest flex items-center gap-2 text-white/60">
                      <Server className="w-4 h-4"/> SMTP Cluster Config
                    </h2>
                    <div className="flex bg-white/5 p-1 rounded border border-white/10">
                      <button 
                        onClick={() => setIsBulkMode(false)}
                        className={cn("px-3 py-1 text-[9px] font-mono uppercase rounded transition-all", !isBulkMode ? "bg-[#00FF88] text-black" : "text-white/40 hover:text-white")}
                      >
                        Visual
                      </button>
                      <button 
                         onClick={() => setIsBulkMode(true)}
                         className={cn("px-3 py-1 text-[9px] font-mono uppercase rounded transition-all", isBulkMode ? "bg-[#00FF88] text-black" : "text-white/40 hover:text-white")}
                      >
                        Bulk Import
                      </button>
                    </div>
                  </div>
                  <div className="flex gap-2.5">
                    <button 
                      onClick={handleSyncSmtp}
                      disabled={smtpSyncing}
                      className="text-[10px] font-mono uppercase bg-[#00FF88]/10 text-[#00FF88] border border-[#00FF88]/25 px-3 py-1 hover:bg-[#00FF88]/20 transition-all flex items-center gap-1.5 disabled:opacity-50 cursor-pointer rounded"
                    >
                      {smtpSyncing ? <Loader2 className="w-3 h-3 animate-spin"/> : <Sparkles className="w-3 h-3"/>}
                      Sync Cluster to Cloud
                    </button>

                    {!isBulkMode && (
                      <button 
                        onClick={addSmtp}
                        className="text-[10px] font-mono uppercase border border-white/20 px-3 py-1 hover:bg-white/10 transition-colors flex items-center gap-1 text-white/80 rounded"
                      >
                        <Plus className="w-3 h-3"/> Provision Node
                      </button>
                    )}
                  </div>
                </div>

                {isBulkMode ? (
                  <div className="space-y-4">
                    <div className="relative">
                      <textarea 
                        value={bulkSmtp || ''}
                        onChange={(e) => handleBulkSmtpChange(e.target.value)}
                        placeholder="smtp.gmail.com 587 user@gmail.com password&#10;smtp.mail.me 465 info@domain.com secret"
                        className="w-full h-[500px] bg-[#111] border border-white/5 rounded-lg p-6 text-xs font-mono focus:border-[#00FF88] outline-none resize-none transition-all placeholder:opacity-20 leading-relaxed"
                      />
                      <div className="absolute top-2 right-2 px-3 py-1 bg-black/60 rounded text-[10px] font-mono text-[#00FF88] border border-white/5">
                        {smtpServers.length} NODES PARSED
                      </div>
                    </div>
                    <p className="text-[10px] text-white/20 font-mono italic uppercase">Format: [HOST] [PORT] [USER] [PASS]</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {smtpServers.map((s, idx) => (
                      <div key={idx} className="bg-[#111] border border-white/5 p-5 rounded-lg relative group transition-all hover:border-white/20">
                        <button 
                          onClick={() => removeSmtp(idx)}
                          className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 p-1 text-white/40 hover:text-red-500 transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <div className="space-y-4">
                          <div className="grid grid-cols-4 gap-3">
                            <div className="col-span-3">
                              <label className="text-[9px] font-mono uppercase opacity-30 tracking-tight">Relay Host</label>
                              <input 
                                value={s.host || ''}
                                onChange={(e) => updateSmtp(idx, 'host', e.target.value)}
                                placeholder="smtp.relay.mx"
                                className="w-full bg-transparent border-b border-white/10 focus:border-[#00FF88] outline-none py-1 text-sm font-mono text-[#00FF88]"
                              />
                            </div>
                            <div>
                              <label className="text-[9px] font-mono uppercase opacity-30 tracking-tight">Port</label>
                              <input 
                                value={s.port !== undefined && s.port !== null ? String(s.port) : ''}
                                onChange={(e) => updateSmtp(idx, 'port', parseInt(e.target.value) || 0)}
                                className="w-full bg-transparent border-b border-white/10 focus:border-[#00FF88] outline-none py-1 text-sm font-mono text-[#00FF88]"
                              />
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="text-[9px] font-mono uppercase opacity-30 tracking-tight">Identity</label>
                              <input 
                                value={s.user || ''}
                                onChange={(e) => updateSmtp(idx, 'user', e.target.value)}
                                className="w-full bg-transparent border-b border-white/10 focus:border-[#00FF88] outline-none py-1 text-sm font-mono"
                              />
                            </div>
                            <div>
                              <label className="text-[9px] font-mono uppercase opacity-30 tracking-tight">Access Secret</label>
                              <input 
                                type="password"
                                value={s.pass || ''}
                                onChange={(e) => updateSmtp(idx, 'pass', e.target.value)}
                                className="w-full bg-transparent border-b border-white/10 focus:border-[#00FF88] outline-none py-1 text-sm font-mono"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </motion.section>
            )}

            {activeTab === 'data' && (
              <motion.section 
                key="data"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-8"
              >
                <div className="text-center space-y-2 mb-4">
                   <h2 className="text-xl font-bold tracking-tight">Distribution Data</h2>
                   <p className="text-[11px] font-mono text-white/30 uppercase tracking-[0.2em]">Orchestrate your targets and assets</p>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {[
                  { title: 'Source Emails', icon: <Users className="w-4 h-4"/>, val: recipients, set: setRecipients, help: 'data.txt' },
                  { title: 'URL Rotation', icon: <ExternalLink className="w-4 h-4"/>, val: links, set: setLinks, help: 'links.txt' },
                  { title: 'Asset Rotation', icon: <Mail className="w-4 h-4"/>, val: images, set: setImages, help: 'images.txt' }
                ].map((col, i) => (
                  <div key={i} className="space-y-4">
                    <h2 className="text-xs font-mono uppercase tracking-widest flex items-center gap-2 border-b border-white/10 pb-2 text-white/60">
                      {col.icon} {col.title}
                    </h2>
                    
                    {col.title === 'Source Emails' && (
                      <div 
                        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                        onDragLeave={() => setIsDragging(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setIsDragging(false);
                          const file = e.dataTransfer.files?.[0];
                          if (file) processFile(file);
                        }}
                        onClick={() => document.getElementById('csv-file-input')?.click()}
                        className={cn(
                          "border border-dashed rounded-lg p-5 flex flex-col items-center justify-center gap-2 text-center transition-all cursor-pointer relative overflow-hidden group",
                          isDragging 
                            ? "border-[#00FF88] bg-[#00FF88]/5" 
                            : "border-white/10 bg-[#111] hover:border-[#00FF88]/30 hover:bg-[#141414]"
                        )}
                      >
                        <input 
                          id="csv-file-input"
                          type="file"
                          accept=".csv,.txt"
                          onChange={handleFileUpload}
                          className="hidden"
                        />
                        <div className={cn(
                          "p-2 rounded-full transition-all duration-300",
                          isDragging ? "bg-[#00FF88]/15 text-[#00FF88]" : "bg-white/5 text-white/40 group-hover:text-[#00FF88] group-hover:bg-[#00FF88]/10"
                        )}>
                          <Upload className="w-4 h-4 transition-transform group-hover:scale-110" />
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-[10px] font-mono uppercase tracking-wider text-white">
                            Upload Distribution List
                          </p>
                          <p className="text-[8px] font-mono text-white/30 uppercase tracking-tight">
                            Click to choose or drag CSV / TXT here
                          </p>
                        </div>

                        {csvStatus && (
                          <div className={cn(
                            "absolute inset-0 flex flex-col items-center justify-center text-center p-3 backdrop-blur-md animate-fade-in",
                            csvStatus.type === 'success' ? "bg-black/95 text-[#00FF88]" : "bg-black/95 text-red-400"
                          )}>
                            <p className="text-[10px] font-mono uppercase tracking-wider flex items-center gap-1.5 font-bold">
                              {csvStatus.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                              {csvStatus.message}
                            </p>
                            <span className="text-[8px] font-mono opacity-40 uppercase tracking-widest mt-1">Ready for deployment</span>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="relative">
                      <textarea 
                        value={col.val || ''}
                        onChange={(e) => col.set(e.target.value)}
                        placeholder={`Paste content for ${col.help}...`}
                        className={cn(
                          "w-full bg-[#111] border border-white/5 rounded-lg p-4 text-[11px] font-mono focus:border-[#00FF88] outline-none resize-none transition-all placeholder:opacity-20",
                          col.title === 'Source Emails' ? 'h-64' : 'h-96'
                        )}
                      />
                      <div className="absolute top-2 right-2 px-2 py-1 bg-black/60 rounded text-[9px] font-mono text-[#00FF88] border border-white/5">
                        {col.val.split('\n').filter(Boolean).length} LINES
                      </div>
                    </div>
                  </div>
                ))}
                </div>
              </motion.section>
            )}

            {activeTab === 'template' && (
              <motion.section 
                key="template"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-3xl mx-auto space-y-10"
              >
                <div className="text-center space-y-2">
                   <h2 className="text-xl font-bold tracking-tight">Campaign Blueprint</h2>
                   <p className="text-[11px] font-mono text-white/30 uppercase tracking-[0.2em]">Define your delivery vector and payload</p>
                </div>

                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-mono uppercase tracking-widest opacity-30">Mask Identity (From Name)</label>
                      <input 
                        value={fromName || ''}
                        onChange={(e) => setFromName(e.target.value)}
                        className="w-full bg-[#111] border border-white/5 rounded-lg px-4 py-3 text-sm outline-none focus:border-[#00FF88] transition-all"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <label className="text-[10px] font-mono uppercase tracking-widest opacity-30">Subject Strategy</label>
                        <button 
                          onClick={() => optimizeContent('subject')}
                          className="text-[10px] font-mono text-[#00FF88] hover:underline flex items-center gap-1.5 opacity-80 hover:opacity-100"
                        >
                          <Sparkles className="w-3 h-3"/> AI OPTIMIZE
                        </button>
                      </div>
                      <input 
                        value={subject || ''}
                        onChange={(e) => setSubject(e.target.value)}
                        className="w-full bg-[#111] border border-white/5 rounded-lg px-4 py-3 text-sm outline-none focus:border-[#00FF88] transition-all"
                      />
                    </div>
                    <div className="space-y-2">
                       <label className="text-[10px] font-mono uppercase tracking-widest opacity-30">Deployment Speed (EMAILS / SEC)</label>
                       <div className="flex items-center gap-4 bg-[#111] border border-white/5 rounded-lg px-4 py-2">
                          <input 
                            type="number"
                            step="0.1"
                            min="0.01"
                            max="100"
                            value={sendSpeed !== undefined && sendSpeed !== null ? sendSpeed : ''}
                            onChange={(e) => setSendSpeed(parseFloat(e.target.value) || 0.1)}
                            className="bg-transparent text-sm font-mono text-[#00FF88] outline-none w-full"
                          />
                          <Activity className="w-4 h-4 text-white/20"/>
                       </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-mono uppercase tracking-widest opacity-30">Raw System Headers</label>
                    <div className="relative">
                      <textarea 
                        value={headersTemplate || ''}
                        onChange={(e) => setHeadersTemplate(e.target.value)}
                        className="w-full h-40 bg-black border border-white/10 rounded-lg p-5 text-[10px] font-mono outline-none resize-none leading-relaxed text-white/60 focus:border-[#00FF88] transition-all"
                      />
                      <div className="absolute bottom-4 right-4 flex flex-wrap gap-2 justify-end max-w-[70%]">
                         <Tag label="[BND]" />
                         <Tag label="[To]" />
                         <Tag label="[Cc]" />
                         <Tag label="[random_id]" />
                         <Tag label="[Date]" />
                         <Tag label="[sender_name]" />
                         <Tag label="[sender_email]" />
                         <Tag label="[Subject]" />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <label className="text-[10px] font-mono uppercase tracking-widest opacity-30">Script Orchestration (HTML)</label>
                      <button 
                         onClick={() => optimizeContent('body')}
                         className="text-[10px] font-mono text-[#00FF88] hover:underline flex items-center gap-1.5 opacity-80 hover:opacity-100"
                      >
                        <Sparkles className="w-3 h-3"/> AI REFINE PAYLOAD
                      </button>
                    </div>
                    <div className="relative">
                      <textarea 
                        value={body || ''}
                        onChange={(e) => setBody(e.target.value)}
                        className="w-full h-80 bg-black border border-white/10 rounded-lg p-5 text-[11px] font-mono outline-none resize-none leading-relaxed text-white/80 focus:border-[#00FF88] transition-all"
                      />
                      <div className="absolute bottom-4 right-4 flex gap-3">
                         <Tag label="[F_Name]" />
                         <Tag label="[Links]" />
                         <Tag label="[images]" />
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 grid grid-cols-1 md:grid-cols-5 gap-4">
                    <button 
                      type="button"
                      onClick={() => setIsPreviewOpen(true)}
                      className="py-5 bg-white/5 text-white border border-white/10 font-bold uppercase tracking-[0.2em] text-xs rounded-lg flex items-center justify-center gap-2.5 hover:bg-white/10 hover:border-white/20 active:scale-[0.98] transition-all cursor-pointer"
                    >
                      <Eye className="w-5 h-5"/> PREVIEW
                    </button>
                    <button 
                      type="button"
                      disabled={templateSyncing}
                      onClick={saveTemplateToCloud}
                      className="py-5 bg-[#00FF88]/10 text-[#00FF88] border border-[#00FF88]/20 font-bold uppercase tracking-[0.2em] text-xs rounded-lg flex items-center justify-center gap-2.5 hover:bg-[#00FF88]/20 active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50"
                    >
                      {templateSyncing ? <Loader2 className="w-5 h-5 animate-spin"/> : <CheckCircle2 className="w-5 h-5"/>}
                      {templateSyncing ? "SAVING DRAFT" : "SAVE DRAFT"}
                    </button>
                    <button 
                      disabled={!!activeJobId || (jobState?.status === 'running' || jobState?.status === 'paused')}
                      onClick={startJob}
                      className="md:col-span-3 py-5 bg-[#00FF88] text-black font-bold uppercase tracking-[0.25em] text-xs rounded-lg flex items-center justify-center gap-4 hover:shadow-[0_0_20px_#00FF8844] active:scale-[0.98] transition-all disabled:opacity-30 disabled:cursor-not-allowed group cursor-pointer"
                    >
                      {(activeJobId || jobState?.status === 'running') ? <Loader2 className="w-5 h-5 animate-spin"/> : <Play className="w-5 h-5 fill-black"/>}
                      {(activeJobId || jobState?.status === 'running') ? "EXECUTING CAMPAIGN" : "INITIALIZE BROADCAST"}
                    </button>
                  </div>
                </div>
              </motion.section>
            )}

            {activeTab === 'history' && (
              <motion.section 
                key="history"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="flex justify-between items-center border-b border-white/10 pb-4">
                   <h2 className="text-xs font-mono uppercase tracking-widest flex items-center gap-2 text-white/60">
                      <History className="w-4 h-4"/> Deployment Archive
                   </h2>
                   <button onClick={fetchHistory} className="text-[10px] font-mono text-[#00FF88] hover:opacity-100 opacity-60 flex items-center gap-2">
                      <RotateCcw className="w-3 h-3" /> Refresh Registry
                   </button>
                </div>

                <div className="space-y-4">
                  {historyJobs.length === 0 ? (
                    <div className="h-40 flex flex-col items-center justify-center border border-white/5 bg-white/[0.02] rounded-xl">
                      <p className="text-[10px] font-mono uppercase text-white/20">Empty Registry</p>
                    </div>
                  ) : historyJobs.map((job) => (
                    <div key={job.id} className="bg-[#111] border border-white/5 p-6 rounded-lg transition-all hover:bg-[#151515] group">
                       <div className="flex flex-col md:flex-row justify-between gap-6">
                          <div className="space-y-4 flex-grow">
                             <div className="flex items-center gap-3">
                                <span className="text-[10px] font-mono bg-white/5 px-2 py-1 rounded text-white/40 border border-white/5 uppercase">
                                   ID: {job.id.substring(0, 8)}
                                </span>
                                <span className={cn(
                                  "text-[9px] font-mono px-2 py-1 rounded uppercase border",
                                  job.status === 'completed' ? "text-[#00FF88] border-[#00FF88]/20 bg-[#00FF88]/5" :
                                  job.status === 'running' ? "text-blue-400 border-blue-400/20 bg-blue-400/5 animate-pulse" :
                                  job.status === 'paused' ? "text-yellow-500 border-yellow-500/20 bg-yellow-500/5" :
                                  job.status === 'failed' ? "text-red-500 border-red-500/20 bg-red-500/5" :
                                  "text-white/20 border-white/10 bg-white/5"
                                )}>
                                  {job.status}
                                </span>
                             </div>

                             <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-8">
                                <div>
                                   <p className="text-[9px] font-mono uppercase text-white/20 mb-1">Start Time</p>
                                   <p className="text-xs font-mono">{job.startTime ? new Date(job.startTime).toLocaleTimeString() : 'N/A'}</p>
                                </div>
                                <div>
                                   <p className="text-[9px] font-mono uppercase text-white/20 mb-1">End Time</p>
                                   <p className="text-xs font-mono">{job.endTime ? new Date(job.endTime).toLocaleTimeString() : (job.status === 'running' || job.status === 'paused' ? 'In Progress' : 'N/A')}</p>
                                </div>
                                <div>
                                   <p className="text-[9px] font-mono uppercase text-white/20 mb-1">Throughput</p>
                                   <p className="text-xs font-mono text-[#00FF88]">{job.sent} Nodes</p>
                                </div>
                                <div>
                                   <p className="text-[9px] font-mono uppercase text-white/20 mb-1">Bounce Count</p>
                                   <p className="text-xs font-mono text-red-500">{job.failed} Errors</p>
                                </div>
                             </div>
                          </div>

                          <div className="flex md:flex-col justify-end gap-2 shrink-0">
                             {(job.status === 'running' || job.status === 'paused') && (
                                <button 
                                  onClick={() => stopHistoricalJob(job.id)}
                                  className="px-4 py-2 bg-red-500/10 text-red-500 border border-red-500/20 rounded text-[10px] font-mono uppercase hover:bg-red-500 hover:text-white transition-all flex items-center gap-2"
                                >
                                  <Square className="w-3 h-3 fill-current"/> Stop
                                </button>
                             )}
                             <button 
                                onClick={() => viewJobDetails(job)}
                                className="px-4 py-2 bg-white/5 text-white/60 border border-white/5 rounded text-[10px] font-mono uppercase hover:bg-white/10 hover:text-white transition-all flex items-center gap-2"
                             >
                                <Eye className="w-3 h-3"/> Details
                             </button>
                             <button 
                                onClick={() => resendJob(job)}
                                className="px-4 py-2 bg-[#00FF88]/5 text-[#00FF88] border border-[#00FF88]/20 rounded text-[10px] font-mono uppercase hover:bg-[#00FF88] hover:text-black transition-all flex items-center gap-2"
                             >
                                <RotateCcw className="w-3 h-3"/> Resend
                             </button>
                          </div>
                       </div>
                    </div>
                  ))}
                </div>
              </motion.section>
            )}

            {activeTab === 'deploy' && (
              <motion.section 
                key="deploy"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-8"
              >
                {!jobState ? (
                  <div className="h-64 flex flex-col items-center justify-center border border-dashed border-white/10 rounded-xl bg-white/[0.02]">
                    <Activity className="w-12 h-12 opacity-5 mb-4" />
                    <p className="text-[10px] font-mono uppercase tracking-widest text-white/20">Awaiting Deployment Payload</p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                      <StatBox label="Success" value={jobState.sent} color="text-[#00FF88]" />
                      <StatBox label="Bounces" value={jobState.failed} color="text-red-500" />
                      <StatBox label="Throughput" value={`${metrics?.speed || 0}/HR`} />
                      <StatBox label="Saturation" value={`${Math.round((jobState.sent + jobState.failed) / jobState.total * 100) || 0}%`} />
                    </div>

                    {/* --- Real-Time Resource Tracking --- */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                       <DeploymentCard 
                          label="Active SMTP Node" 
                          icon={<Server className="w-4 h-4 text-white/40" />} 
                          value={jobState.currentSmtp || 'No active relay'}
                          subValue="SMTP Relay Rotation: INJECTED"
                       />
                       <DeploymentCard 
                          label="Target URL Rotation" 
                          icon={<ExternalLink className="w-4 h-4 text-white/40" />} 
                          value={jobState.currentLink || 'No link active'}
                          subValue="Dynamic Link Masking: ENABLED"
                       />
                       <DeploymentCard 
                          label="Active Media Asset" 
                          icon={<Mail className="w-4 h-4 text-white/40" />} 
                          value={jobState.currentImage || 'No asset active'}
                          subValue="Image Obfuscation: ACTIVE"
                       />
                    </div>

                    <div className="grid grid-cols-2 gap-6">
                       <MetricBox label="Deployment Time" value={metrics?.elapsed || '00:00:00'} />
                       <MetricBox label="Time To Completion" value={metrics?.eta || '00:00:00'} />
                    </div>

                    <div className="space-y-4">
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                        <div className="flex items-center gap-4 flex-wrap">
                           <div className="flex items-center gap-2">
                              <div className="w-1 h-3 bg-[#00FF88]"></div>
                              <h3 className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/40 font-bold">Deploy Live Feed</h3>
                           </div>
                           <span className="text-[9px] font-mono bg-white/5 px-2 py-0.5 rounded text-white/40 border border-white/5 uppercase">
                              Nodes: {jobState.total}
                           </span>
                           
                           {/* --- Auto-Scroll Toggle Switch --- */}
                           <div className="flex items-center gap-2 select-none border-l border-white/10 pl-4 ml-1">
                              <button 
                                onClick={() => setAutoScroll(!autoScroll)}
                                className={cn(
                                  "relative inline-flex h-4 w-8 shrink-0 cursor-pointer rounded-full border border-white/10 transition-colors duration-200 ease-in-out focus:outline-none",
                                  autoScroll ? "bg-[#00FF88]" : "bg-white/5"
                                )}
                              >
                                <span
                                  className={cn(
                                    "pointer-events-none inline-block h-2.5 w-2.5 transform rounded-full shadow transition duration-200 ease-in-out mt-0.5 ml-0.5",
                                    autoScroll ? "translate-x-4 bg-black" : "translate-x-0 bg-white/30"
                                  )}
                                />
                              </button>
                              <span className="text-[9px] font-mono uppercase tracking-wider text-white/30">Auto-Scroll</span>
                           </div>
                        </div>
                        <div className="flex gap-2">
                          {(jobState.status === 'running') && (
                            <button onClick={pauseJob} className="text-[9px] font-mono uppercase text-yellow-500 border border-yellow-500/20 px-3 py-1 rounded hover:bg-yellow-500/10 transition-colors flex items-center gap-2">
                              <Square className="w-3 h-3 fill-yellow-500"/> Suspend
                            </button>
                          )}
                          {(jobState.status === 'paused') && (
                            <button onClick={resumeJob} className="text-[9px] font-mono uppercase text-[#00FF88] border border-[#00FF88]/20 px-3 py-1 rounded hover:bg-[#00FF88]/10 transition-colors flex items-center gap-2">
                              <Play className="w-3 h-3 fill-[#00FF88]"/> Resume
                            </button>
                          )}
                          {(jobState.status === 'running' || jobState.status === 'paused') && (
                            <button onClick={stopJob} className="text-[9px] font-mono uppercase text-red-500 border border-red-500/20 px-3 py-1 rounded hover:bg-red-500/10 transition-colors">
                              Emergency Kill
                            </button>
                          )}
                        </div>
                      </div>
                      <div 
                        ref={logsRef}
                        className="bg-black border border-white/10 rounded-lg p-6 h-[400px] overflow-y-auto font-mono text-[10px] leading-relaxed scrollbar-thin scrollbar-thumb-white/10"
                      >
                        {jobState.logs.map((log, i) => (
                          <div key={i} className={cn(
                            "mb-1.5 flex gap-4",
                            log.includes('✅') ? "text-[#00FF88]" : log.includes('❌') ? "text-red-400" : "text-white/40"
                          )}>
                            <span className="opacity-20 shrink-0">[{new Date().toLocaleTimeString()}]</span>
                            <span className="break-all">{log}</span>
                          </div>
                        ))}
                        {(jobState.status === 'running') && (
                          <div className="flex items-center gap-2 text-[#00FF88]/60 mt-3 animate-pulse italic">
                             <Loader2 className="w-3 h-3 animate-spin"/>
                             <span>Cycling SMTP relay cluster...</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </motion.section>
            )}
          </AnimatePresence>
        </div>

        <footer className="mt-12 flex flex-col md:flex-row justify-center items-center gap-8 text-[10px] text-white/10 uppercase tracking-[0.3em] font-mono border-t border-white/5 pt-8">
          <div className="flex gap-12">
            <span className="flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-white/20"></span>
              Peak Rate: 400 MSG/HR
            </span>
            <span className="flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-white/20"></span>
              Transmission: AES-256
            </span>
          </div>
          <div className="opacity-40">
            <span>&copy; GENIUS-CORE 2024</span>
          </div>
        </footer>
      </main>

      {/* --- Overlay UI for AI status --- */}
      <AnimatePresence>
        {isAiLoading && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#050505]/95 backdrop-blur-xl z-[100] flex items-center justify-center flex-col gap-6"
          >
             <Sparkles className="w-16 h-16 text-[#00FF88] animate-pulse drop-shadow-[0_0_15px_#00FF8888]" />
             <div className="flex flex-col items-center gap-1">
               <p className="font-mono text-sm uppercase tracking-[0.3em] text-white">Gemini Synth Engine</p>
               <p className="font-mono text-[10px] uppercase text-[#00FF88] tracking-widest opacity-60">Optimizing delivery payload...</p>
             </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* --- Overlay UI for Campaign Preview --- */}
      <AnimatePresence>
        {isPreviewOpen && (() => {
          const preview = getPreviewContent();
          return (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-[#050505]/95 backdrop-blur-md z-[100] flex items-center justify-center p-4 md:p-6"
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                className="bg-[#0c0c0c] border border-white/10 rounded-xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden shadow-[0_0_50px_rgba(0,255,136,0.05)] text-white"
              >
                {/* Modal Header */}
                <div className="border-b border-white/5 px-6 py-4 flex justify-between items-center bg-[#0e0e0e]">
                  <div className="flex items-center gap-3">
                     <span className="p-1.5 bg-[#00FF88]/15 rounded text-[#00FF88]">
                        <Eye className="w-4 h-4" />
                     </span>
                     <div>
                        <h3 className="text-sm font-bold tracking-tight uppercase text-white">Live Payload Preview</h3>
                        <p className="text-[9px] font-mono text-white/30 uppercase tracking-wider">Simulated broadcast output compilation</p>
                     </div>
                  </div>
                  <button 
                    onClick={() => setIsPreviewOpen(false)}
                    className="text-white/40 hover:text-white transition-colors cursor-pointer p-1"
                  >
                    <XCircle className="w-6 h-6" />
                  </button>
                </div>

                {/* Modal Content */}
                <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
                  
                  {/* Left Metadata Panel */}
                  <div className="space-y-4 lg:col-span-1">
                    <div className="bg-[#111] border border-white/5 rounded-lg p-5 space-y-4">
                      <h4 className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#00FF88] font-bold border-b border-white/5 pb-2">Simulation Vectors</h4>
                      
                      <div className="space-y-1">
                        <span className="text-[9px] font-mono uppercase opacity-30 tracking-wider block">Mask Identity (From)</span>
                        <p className="text-xs font-mono text-white bg-black/40 px-3 py-1.5 rounded border border-white/5 truncate font-semibold">{preview.fromName || '(Empty)'}</p>
                      </div>

                      <div className="space-y-1">
                        <span className="text-[9px] font-mono uppercase opacity-30 tracking-wider block">Sender Relay IP (Email)</span>
                        <p className="text-xs font-mono text-[#00FF88] bg-black/40 px-3 py-1.5 rounded border border-white/5 truncate">{preview.senderEmail || 'delivery@relay.com'}</p>
                      </div>

                      <div className="space-y-1">
                        <span className="text-[9px] font-mono uppercase opacity-30 tracking-wider block">Target Recipient</span>
                        <p className="text-xs font-mono text-white bg-black/40 px-3 py-1.5 rounded border border-white/5 truncate">{preview.recipient}</p>
                      </div>

                      <div className="space-y-1">
                        <span className="text-[9px] font-mono uppercase opacity-30 tracking-wider block">Subject Strategy</span>
                        <p className="text-xs font-mono text-white bg-black/40 px-3 py-1.5 rounded border border-white/5 font-semibold leading-relaxed">{preview.subject || '(No Subject)'}</p>
                      </div>
                    </div>

                    <div className="bg-[#111]/60 border border-white/5 rounded-lg p-5 space-y-3">
                      <h4 className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/30 font-bold">Rotation Resolution</h4>
                      <div className="grid grid-cols-2 gap-3 text-[10px] font-mono">
                         <div>
                            <span className="opacity-30 block">F_Name:</span>
                            <span className="text-white/70 block truncate">{preview.recipient.split('@')[0]}</span>
                         </div>
                         <div>
                            <span className="opacity-30 block">Links:</span>
                            <span className="text-[#00FF88] block truncate">Rotated #1</span>
                         </div>
                         <div>
                            <span className="opacity-30 block">Assets:</span>
                            <span className="text-white/70 block truncate">Rotated #1</span>
                         </div>
                         <div>
                            <span className="opacity-30 block">Hash ID:</span>
                            <span className="text-white/40 block truncate">Generated</span>
                         </div>
                      </div>
                    </div>
                  </div>

                  {/* Right Display Area */}
                  <div className="lg:col-span-2 flex flex-col h-[50vh] lg:h-auto border border-white/5 rounded-lg overflow-hidden bg-black">
                     
                     {/* Tab Headers */}
                     <div className="flex border-b border-white/5 bg-[#111] p-1.5 gap-1.5">
                        <button
                          key="render"
                          onClick={() => setPreviewTab('render')}
                          className={cn(
                            "px-4 py-1.5 rounded text-[10px] font-mono uppercase tracking-wider transition-all cursor-pointer",
                            previewTab === 'render' 
                              ? "bg-[#00FF88] text-black font-bold shadow-[0_0_8px_#00FF8844]" 
                              : "text-white/40 hover:text-white/80"
                          )}
                        >
                          Rendered HTML
                        </button>
                        <button
                          key="html"
                          onClick={() => setPreviewTab('html')}
                          className={cn(
                            "px-4 py-1.5 rounded text-[10px] font-mono uppercase tracking-wider transition-all cursor-pointer",
                            previewTab === 'html' 
                              ? "bg-[#00FF88] text-black font-bold shadow-[0_0_8px_#00FF8844]" 
                              : "text-white/40 hover:text-white/80"
                          )}
                        >
                          Payload Source
                        </button>
                        <button
                          key="headers"
                          onClick={() => setPreviewTab('headers')}
                          className={cn(
                            "px-4 py-1.5 rounded text-[10px] font-mono uppercase tracking-wider transition-all cursor-pointer",
                            previewTab === 'headers' 
                              ? "bg-[#00FF88] text-black font-bold shadow-[0_0_8px_#00FF8844]" 
                              : "text-white/40 hover:text-white/80"
                          )}
                        >
                          System Headers
                        </button>
                     </div>

                     {/* Tab Body */}
                     <div className="flex-1 relative overflow-hidden bg-[#0a0a0a]">
                        {previewTab === 'render' && (
                          <div className="absolute inset-0 bg-white">
                             <iframe 
                                title="Email Render Preview"
                                srcDoc={`
                                  <!DOCTYPE html>
                                  <html>
                                    <head>
                                      <meta charset="utf-8">
                                      <style>
                                        body {
                                          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                                          color: #333333;
                                          background-color: #ffffff;
                                          margin: 0;
                                          padding: 24px;
                                          line-height: 1.6;
                                        }
                                        img {
                                          max-width: 100%;
                                          height: auto;
                                        }
                                      </style>
                                    </head>
                                    <body>
                                      ${preview.body || '<div style="color: #999; font-style: italic; text-align: center; padding: 40px;">(Empty email body payload)</div>'}
                                    </body>
                                  </html>
                                `}
                                className="w-full h-full border-0"
                                sandbox="allow-same-origin"
                             />
                          </div>
                        )}

                        {previewTab === 'html' && (
                          <div className="absolute inset-0 p-5 overflow-auto font-mono text-[11px] text-white/85 leading-relaxed bg-[#0c0c0c] scrollbar-thin select-text">
                             <pre className="whitespace-pre-wrap break-all select-all">{preview.body || '<!-- No body payload -->'}</pre>
                          </div>
                        )}

                        {previewTab === 'headers' && (
                          <div className="absolute inset-0 p-5 overflow-auto font-mono text-[10px] text-white/60 leading-relaxed bg-[#0c0c0c] scrollbar-thin select-text">
                             <pre className="whitespace-pre-wrap break-all select-all">{preview.headers || 'No transmission headers specified.'}</pre>
                          </div>
                        )}
                     </div>
                  </div>
                </div>

                {/* Footer Controls */}
                <div className="border-t border-white/5 px-6 py-4 bg-[#0e0e0e] flex justify-between items-center">
                   <p className="text-[9px] font-mono text-white/20 uppercase tracking-widest">
                      Preview compiled dynamically from active databases
                   </p>
                   <button 
                     onClick={() => setIsPreviewOpen(false)}
                     className="px-5 py-2 bg-white/5 hover:bg-white/10 text-white rounded text-[10px] font-mono uppercase tracking-wider transition-colors cursor-pointer"
                   >
                     Close Window
                   </button>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}

// --- Subcomponents ---

function TopNavBtn({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-4 py-1.5 rounded-md transition-all duration-200 text-[11px] font-mono uppercase tracking-wider",
        active ? "bg-[#00FF88] text-black font-bold" : "text-white/40 hover:text-white/80 hover:bg-white/5"
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Tag({ label }: { label: string }) {
  return (
    <span className="px-2 py-1 bg-white/5 text-[#00FF88] text-[9px] font-mono rounded border border-white/5 cursor-default hover:border-[#00FF88]/40 transition-colors">
      {label}
    </span>
  );
}

function StatBox({ label, value, color }: { label: string, value: string | number, color?: string }) {
  return (
    <div className="bg-[#111] border border-white/5 p-6 rounded-lg transition-all hover:border-white/10 group">
      <span className="block text-[10px] font-mono uppercase opacity-30 tracking-widest mb-2">{label}</span>
      <span className={cn("text-3xl font-bold tracking-tighter flex items-center justify-center gap-2", color || "text-white")}>
        {value}
      </span>
    </div>
  )
}

function MetricBox({ label, value }: { label: string, value: string }) {
  return (
    <div className="bg-[#111] border border-white/5 p-4 rounded-lg flex justify-between items-center">
       <span className="text-[10px] font-mono uppercase opacity-30 tracking-widest">{label}</span>
       <span className="text-xl font-mono font-bold tracking-tight text-white/80">{value}</span>
    </div>
  )
}

function DeploymentCard({ label, icon, value, subValue }: { label: string, icon: React.ReactNode, value: string, subValue: string }) {
  return (
    <div className="bg-[#111] border border-white/5 p-5 rounded-lg flex flex-col gap-4 relative overflow-hidden group">
       <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:opacity-20 transition-opacity">
          {icon}
       </div>
       <div>
          <span className="text-[9px] font-mono uppercase opacity-30 tracking-widest block mb-1">{label}</span>
          <span className="text-xs font-mono text-[#00FF88] font-bold break-all">{value}</span>
       </div>
       <div className="pt-2 border-t border-white/5">
          <span className="text-[8px] font-mono uppercase opacity-20 tracking-tighter">{subValue}</span>
       </div>
    </div>
  )
}

