import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase, isSupabaseConfigured } from '../config/supabase.js';
import { verifyAdmin } from '../utils/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const consultationsJsonPath = path.resolve(__dirname, '../../data/consultations.json');

// In-memory fallback cache
const memoryConsultations = [];

// Helper to save consultation to local JSON fallback
const saveLocalConsultationFallback = (cons) => {
  try {
    memoryConsultations.unshift(cons);
    let list = [];
    if (fs.existsSync(consultationsJsonPath)) {
      try {
        const raw = fs.readFileSync(consultationsJsonPath, 'utf8');
        list = JSON.parse(raw);
      } catch (e) {
        list = [];
      }
    }
    list.unshift(cons);
    fs.writeFileSync(consultationsJsonPath, JSON.stringify(list.slice(0, 100), null, 2), 'utf8');
  } catch (err) {
    console.warn('Could not write to local consultations.json (normal in read-only serverless):', err.message);
  }
};

// Helper to get local fallback consultations
const getLocalConsultationsFallback = () => {
  try {
    if (fs.existsSync(consultationsJsonPath)) {
      const raw = fs.readFileSync(consultationsJsonPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('Could not read consultations.json fallback:', err.message);
  }
  return memoryConsultations;
};

// 1. Submit a new consultation request
export const submitConsultation = async (req, res) => {
  try {
    const { full_name, name, email, phone, subject, message } = req.body || {};

    const fullName = String(full_name || name || '').trim();
    const clientEmail = String(email || '').trim();
    const clientMessage = String(message || '').trim();
    const clientPhone = String(phone || '').trim();
    const clientSubject = String(subject || '').trim();

    if (!fullName || !clientEmail || !clientMessage) {
      return res.status(400).json({ success: false, error: 'Full name, email, and message are required fields' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(clientEmail)) {
      return res.status(400).json({ success: false, error: 'Please provide a valid email address' });
    }

    const savedConsultation = {
      id: 'cons-' + Date.now(),
      full_name: fullName,
      email: clientEmail,
      phone: clientPhone,
      subject: clientSubject,
      message: clientMessage,
      created_at: new Date().toISOString()
    };

    // Try saving to Supabase with a strict timeout so it never hangs serverless execution
    if (isSupabaseConfigured && supabase) {
      try {
        const supabasePromise = supabase
          .from('consultations')
          .insert([savedConsultation])
          .select();

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Supabase request timed out')), 3500)
        );

        const result = await Promise.race([supabasePromise, timeoutPromise]);
        if (result && !result.error && result.data && result.data.length > 0) {
          console.log('Saved consultation to Supabase successfully.');
        } else if (result?.error) {
          console.warn('Supabase insert warning (using local fallback):', result.error.message);
        }
      } catch (dbErr) {
        console.warn('Supabase insert skipped (using local fallback):', dbErr.message);
      }
    }

    // Always record locally as fallback
    saveLocalConsultationFallback(savedConsultation);

    // Send email notification directly via Resend API
    const resendApiKey = process.env.RESEND_API_KEY;
    let toEmail = process.env.TO_EMAIL_ADDRESS || 'hassaanashfaq51@gmail.com';
    // Ensure email is correctly addressed to account owner
    if (toEmail.toLowerCase().includes('hassanashfaq51@')) {
      toEmail = 'hassaanashfaq51@gmail.com';
    }

    if (resendApiKey) {
      try {
        const emailSubject = clientSubject 
          ? `Free Consultation Request: ${clientSubject} - ${savedConsultation.full_name}`
          : `New Free Consultation Request from ${savedConsultation.full_name}`;

        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
            <h2 style="color: #4f46e5; margin-top: 0;">New Free Consultation Request</h2>
            <p style="color: #475569; font-size: 14px;">A client has requested a free technical consultation via your portfolio website:</p>
            <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px;">
              <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #334155; width: 140px;">Client Name:</td>
                <td style="padding: 8px 0; color: #0f172a;">${savedConsultation.full_name}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #334155;">Client Email:</td>
                <td style="padding: 8px 0;"><a href="mailto:${savedConsultation.email}" style="color: #4f46e5; text-decoration: none;">${savedConsultation.email}</a></td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #334155;">Phone Number:</td>
                <td style="padding: 8px 0; color: #0f172a;">${savedConsultation.phone || 'Not provided'}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #334155;">Subject / Topic:</td>
                <td style="padding: 8px 0; color: #0f172a;">${savedConsultation.subject || 'Technical Consultation'}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-weight: bold; color: #334155;">Received At:</td>
                <td style="padding: 8px 0; color: #64748b;">${new Date().toUTCString()}</td>
              </tr>
            </table>
            <div style="margin-top: 16px;">
              <h4 style="margin: 0 0 8px 0; color: #334155;">Project Requirements & Details:</h4>
              <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 14px; color: #1e293b; white-space: pre-wrap; font-size: 14px; line-height: 1.6;">
${savedConsultation.message}
              </div>
            </div>
            <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
              Sent securely from Muhammad Hassaan's Portfolio Consultation Form
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
            from: 'Portfolio Consultation <onboarding@resend.dev>',
            to: [toEmail],
            reply_to: savedConsultation.email,
            subject: emailSubject,
            html: emailHtml
          })
        });

        const emailData = await emailResponse.json();
        if (emailResponse.ok) {
          console.log('Consultation notification email sent via Resend:', emailData.id);
        } else {
          console.error('Resend delivery note:', emailData);
        }
      } catch (emailErr) {
        console.error('Email dispatch error (consultation saved regardless):', emailErr.message);
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Consultation request submitted successfully!',
      data: savedConsultation
    });
  } catch (error) {
    console.error('Consultation submission error:', error);
    return res.status(500).json({ success: false, error: 'Failed to submit consultation request: ' + error.message });
  }
};

// 2. Get all consultation requests (Admin only)
export const getConsultations = async (req, res) => {
  try {
    const isAdmin = await verifyAdmin(req);
    if (!isAdmin) {
      return res.status(401).json({ error: 'Unauthorized: Admin access required' });
    }

    if (isSupabaseConfigured && supabase) {
      try {
        const { data, error } = await supabase
          .from('consultations')
          .select('*')
          .order('created_at', { ascending: false });

        if (!error && Array.isArray(data) && data.length > 0) {
          return res.json(data);
        }
      } catch (err) {
        console.warn('Supabase retrieval failed, using fallback:', err.message);
      }
    }

    const localConsultations = getLocalConsultationsFallback();
    return res.json(localConsultations);
  } catch (error) {
    const localConsultations = getLocalConsultationsFallback();
    return res.json(localConsultations);
  }
};

