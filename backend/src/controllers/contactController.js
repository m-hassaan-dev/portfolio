import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase, isSupabaseConfigured } from '../config/supabase.js';
import { verifyAdmin } from '../utils/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const messagesJsonPath = path.resolve(__dirname, '../../data/messages.json');

// In-memory fallback cache
const memoryMessages = [];

// Helper to save message to local JSON fallback
const saveLocalMessageFallback = (msg) => {
  try {
    memoryMessages.unshift(msg);
    let list = [];
    if (fs.existsSync(messagesJsonPath)) {
      try {
        const raw = fs.readFileSync(messagesJsonPath, 'utf8');
        list = JSON.parse(raw);
      } catch (e) {
        list = [];
      }
    }
    list.unshift(msg);
    fs.writeFileSync(messagesJsonPath, JSON.stringify(list.slice(0, 100), null, 2), 'utf8');
  } catch (err) {
    console.warn('Could not write to local messages.json (normal in read-only serverless):', err.message);
  }
};

// Helper to get local fallback messages
const getLocalMessagesFallback = () => {
  try {
    if (fs.existsSync(messagesJsonPath)) {
      const raw = fs.readFileSync(messagesJsonPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('Could not read messages.json fallback:', err.message);
  }
  return memoryMessages;
};

// 1. Submit a new contact message
export const submitMessage = async (req, res) => {
  try {
    const { name, email, message } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({ success: false, error: 'Name, email, and message are required fields' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(String(email).trim())) {
      return res.status(400).json({ success: false, error: 'Please provide a valid email address' });
    }

    const savedMessage = {
      id: 'msg-' + Date.now(),
      name: String(name).trim(),
      email: String(email).trim(),
      message: String(message).trim(),
      created_at: new Date().toISOString()
    };

    // Try saving to Supabase with a strict timeout so it never hangs serverless execution
    if (isSupabaseConfigured && supabase) {
      try {
        const supabasePromise = supabase
          .from('contact_messages')
          .insert([savedMessage])
          .select();

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Supabase request timed out')), 3500)
        );

        const result = await Promise.race([supabasePromise, timeoutPromise]);
        if (result && !result.error && result.data && result.data.length > 0) {
          console.log('Saved contact message to Supabase successfully.');
        } else if (result?.error) {
          console.warn('Supabase insert warning (using local fallback):', result.error.message);
        }
      } catch (dbErr) {
        console.warn('Supabase insert skipped (using local fallback):', dbErr.message);
      }
    }

    // Always record locally as fallback
    saveLocalMessageFallback(savedMessage);

    // Send email notification directly via Resend API
    const resendApiKey = process.env.RESEND_API_KEY;
    let toEmail = process.env.TO_EMAIL_ADDRESS || 'hassaanashfaq51@gmail.com';
    // Ensure email is correctly addressed to account owner
    if (toEmail.toLowerCase().includes('hassanashfaq51@')) {
      toEmail = 'hassaanashfaq51@gmail.com';
    }

    if (resendApiKey) {
      try {
        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
            <h2 style="color: #4f46e5; margin-top: 0;">New Portfolio Contact Message</h2>
            <p style="color: #475569; font-size: 14px;">You have received a new contact inquiry from your portfolio website:</p>
            <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;">
              <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #334155; width: 120px;">Sender Name:</td>
                <td style="padding: 8px 0; color: #0f172a;">${savedMessage.name}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #334155;">Sender Email:</td>
                <td style="padding: 8px 0;"><a href="mailto:${savedMessage.email}" style="color: #4f46e5; text-decoration: none;">${savedMessage.email}</a></td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #334155;">Received At:</td>
                <td style="padding: 8px 0; color: #64748b;">${new Date().toUTCString()}</td>
              </tr>
            </table>
            <div style="margin-top: 16px;">
              <h4 style="margin: 0 0 8px 0; color: #334155;">Message Content:</h4>
              <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 14px; color: #1e293b; white-space: pre-wrap; font-size: 14px; line-height: 1.6;">
${savedMessage.message}
              </div>
            </div>
            <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
              Sent securely from Muhammad Hassaan's Portfolio Contact Form
            </div>
          </div>
        `;

        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Portfolio Contact <onboarding@resend.dev>',
            to: [toEmail],
            reply_to: savedMessage.email,
            subject: `New Message from ${savedMessage.name} via Portfolio`,
            html: emailHtml
          })
        });

        const emailData = await emailResponse.json();
        if (emailResponse.ok) {
          console.log('Contact message notification sent via Resend:', emailData.id);
        } else {
          console.error('Resend delivery note:', emailData);
        }
      } catch (emailErr) {
        console.error('Email dispatch error (inquiry saved regardless):', emailErr.message);
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Your message has been sent successfully!',
      data: savedMessage
    });
  } catch (error) {
    console.error('Contact submission error:', error);
    return res.status(500).json({ success: false, error: 'Failed to submit message: ' + error.message });
  }
};

// 2. Get all contact messages (Admin only)
export const getMessages = async (req, res) => {
  try {
    const isAdmin = await verifyAdmin(req);
    if (!isAdmin) {
      return res.status(401).json({ error: 'Unauthorized: Admin access required' });
    }

    if (isSupabaseConfigured && supabase) {
      try {
        const { data, error } = await supabase
          .from('contact_messages')
          .select('*')
          .order('created_at', { ascending: false });

        if (!error && Array.isArray(data) && data.length > 0) {
          return res.json(data);
        }
      } catch (err) {
        console.warn('Supabase retrieval failed, using fallback:', err.message);
      }
    }

    const localMessages = getLocalMessagesFallback();
    return res.json(localMessages);
  } catch (error) {
    const localMessages = getLocalMessagesFallback();
    return res.json(localMessages);
  }
};
