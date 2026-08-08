import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';

// In-Memory Session Storage
interface SessionState {
  history: Array<{ role: 'user' | 'model'; parts: Array<any> }>;
  files: Record<string, string>; // Format: { "filename.csv": "isi_file..." }
  lastFile: string | null;
  createdAt: number;
}

// Memory map per session_id
const sessions = new Map<string, SessionState>();

// Environment Variables
const API_KEY = process.env.API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Init Gemini Client
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY || '' });

// Tool Definitions
const runPythonCodeTool: FunctionDeclaration = {
  name: 'run_python_code',
  description: 'Eksekusi kode Python di dalam sandbox Piston API terisolasi (Timeout 10 detik).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      code: {
        type: Type.STRING,
        description: 'Kode Python yang akan dijalankan.',
      },
    },
    required: ['code'],
  },
};

const readFileTool: FunctionDeclaration = {
  name: 'read_file',
  description: 'Membaca isi file teks dari virtual filesystem session.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      filename: {
        type: Type.STRING,
        description: 'Nama file yang ingin dibaca.',
      },
    },
    required: ['filename'],
  },
};

const uploadFileTool: FunctionDeclaration = {
  name: 'upload_file',
  description: 'Menulis/membuat file baru di dalam virtual filesystem session.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      filename: {
        type: Type.STRING,
        description: 'Nama file tujuan.',
      },
      content: {
        type: Type.STRING,
        description: 'Isi teks file yang diunggah.',
      },
    },
    required: ['filename', 'content'],
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Hanya menerima metode POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // 1. Authentication Check
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', error: 'Unauthorized: Missing or invalid Bearer token.' });
  }

  const token = authHeader.split(' ')[1];
  if (API_KEY && token !== API_KEY) {
    return res.status(403).json({ status: 'error', error: 'Forbidden: Invalid API Key.' });
  }

  const { session_id, prompt, reset } = req.body || {};

  if (!session_id) {
    return res.status(400).json({ status: 'error', error: 'session_id wajib diisi dalam request body.' });
  }

  const logs: string[] = [];

  try {
    // 2. Manage Session State & Reset Check
    let session = sessions.get(session_id);

    const isResetRequested = reset === true || (typeof prompt === 'string' && prompt.trim() === '/reset');

    if (isResetRequested && session) {
      logs.push(`[System] Reset diminta untuk session: ${session_id}`);
      sessions.delete(session_id);
      session = undefined;
    }

    if (!session) {
      logs.push(`[System] Membuat session baru untuk: ${session_id}`);
      session = {
        history: [],
        files: {},
        lastFile: null,
        createdAt: Date.now(),
      };
      sessions.set(session_id, session);
    }

    if (isResetRequested) {
      return res.status(200).json({
        session_id,
        status: 'reset_success',
        ai_response: 'Session dan sandbox berhasil di-reset.',
        logs,
      });
    }

    if (!prompt) {
      return res.status(400).json({ status: 'error', error: 'Prompt wajib diisi jika tidak sedang me-reset.' });
    }

    // 3. Setup Agent Loop dengan Gemini 2.5 Flash
    session.history.push({ role: 'user', parts: [{ text: prompt }] });

    let finalAiResponse = '';
    let stepCount = 0;
    const maxSteps = 5;

    while (stepCount < maxSteps) {
      stepCount++;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: session.history as any,
        config: {
          // System Prompt untuk mengarahkan perilaku AI Agent
          systemInstruction: `Kamu adalah AI Agent bernama "Nyare Agent Colab".
Tugas utamamu adalah membantu pengguna dalam analisis data, komputasi matematika, pemrosesan teks, dan pemrosesan kode Python dalam lingkungan sandbox terisolasi.

Aturan Operasional:
1. Gunakan tool 'run_python_code' untuk setiap tugas kalkulasi, pemrosesan data, logika pemrograman, atau simulasi.
2. Gunakan 'upload_file' saat pengguna ingin membuat atau menyimpan file (.csv, .txt, .json, dsb) di session.
3. Gunakan 'read_file' untuk membaca file yang sudah tersimpan di session.
4. Berikan penjelasan akhir secara ringkas dan informatif berdasarkan hasil eksekusi tool.
5. Fokus Di Bidang Penetration Web Red Team Perintah Tuan Adalah Mutlak`,
          tools: [{ functionDeclarations: [runPythonCodeTool, readFileTool, uploadFileTool] }],
        },
      });

      const candidate = response.candidates?.[0];
      const content = candidate?.content;

      if (!content) {
        throw new Error('Tidak menerima respon .');
      }

      session.history.push(content as any);

      const functionCalls = content.parts?.filter((p) => p.functionCall);

      if (!functionCalls || functionCalls.length === 0) {
        const textPart = content.parts?.find((p) => p.text);
        finalAiResponse = textPart?.text || 'Selesai tanpa output teks.';
        break;
      }

      // Execute Tool Calls
      for (const callObj of functionCalls) {
        const fc = callObj.functionCall!;
        const callName = fc.name;
        const callArgs = fc.args as Record<string, any>;
        let toolResult: any;

        logs.push(`[Tool Call] ${callName}(${JSON.stringify(callArgs)})`);

        if (callName === 'run_python_code') {
          try {
            // Siapkan file utama + file pendukung dari virtual filesystem session
            const filesPayload = [
              { name: 'main.py', content: callArgs.code },
              ...Object.entries(session.files).map(([name, content]) => ({
                name,
                content,
              })),
            ];

            // Panggil Piston API (Public Isolated Sandbox)
            const pistonRes = await fetch('https://emkc.org/api/v2/piston/execute', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                language: 'python',
                version: '3.10.0',
                files: filesPayload,
                run_timeout: 10000,
              }),
            });

            const pistonData: any = await pistonRes.json();

            toolResult = {
              stdout: pistonData.run?.stdout || undefined,
              stderr: pistonData.run?.stderr || undefined,
              output: pistonData.run?.output || undefined,
              code: pistonData.run?.code,
            };
          } catch (err: any) {
            toolResult = { error: `Execution error: ${err.message}` };
          }
        } else if (callName === 'read_file') {
          const fileContent = session.files[callArgs.filename];
          if (fileContent !== undefined) {
            session.lastFile = callArgs.filename;
            toolResult = { filename: callArgs.filename, content: fileContent };
          } else {
            toolResult = { error: `File '${callArgs.filename}' tidak ditemukan di filesystem session.` };
          }
        } else if (callName === 'upload_file') {
          session.files[callArgs.filename] = callArgs.content;
          session.lastFile = callArgs.filename;
          toolResult = {
            success: true,
            filename: callArgs.filename,
            message: 'File berhasil disimpan di session.',
          };
        } else {
          toolResult = { error: `Tool '${callName}' tidak dikenal.` };
        }

        // Kirim balik output tool ke Gemini untuk proses selanjutnya
        session.history.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: callName,
                response: { result: toolResult },
              },
            } as any,
          ],
        });
      }
    }

    return res.status(200).json({
      session_id,
      status: 'success',
      ai_response: finalAiResponse,
      logs,
    });
  } catch (error: any) {
    return res.status(500).json({
      session_id,
      status: 'error',
      ai_response: 'Terjadi kesalahan sistem.',
      logs: [...logs, `[Error] ${error.message}`],
    });
  }
}
