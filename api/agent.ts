import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import { CodeInterpreter } from '@e2b/code-interpreter';

// In-Memory Session Storage
interface SessionState {
  sandbox: CodeInterpreter | null;
  history: Array<{ role: 'user' | 'model'; parts: Array<{ text?: string }> }>;
  lastFile: string | null;
  createdAt: number;
}

// Memory map per session_id (Catatan: Pada Vercel Serverless, memory bertahap selama container warm)
const sessions = new Map<string, SessionState>();

// Environment Variables
const API_KEY = process.env.API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const E2B_API_KEY = process.env.E2B_API_KEY;

// Init Gemini Client
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY || '' });

// Tool Definitions
const runPythonCodeTool: FunctionDeclaration = {
  name: 'run_python_code',
  description: 'Eksekusi kode Python di dalam E2B sandbox (Timeout 10 detik, tanpa akses internet).',
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
  description: 'Membaca isi file teks dari filesystem E2B sandbox.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      filename: {
        type: Type.STRING,
        description: 'Nama file atau path relatif di sandbox.',
      },
    },
    required: ['filename'],
  },
};

const uploadFileTool: FunctionDeclaration = {
  name: 'upload_file',
  description: 'Menulis/membuat file baru di dalam filesystem E2B sandbox.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      filename: {
        type: Type.STRING,
        description: 'Nama file atau path tujuan.',
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
      if (session.sandbox) {
        await session.sandbox.kill().catch(() => {});
      }
      sessions.delete(session_id);
      session = undefined;
    }

    if (!session) {
      logs.push(`[System] Membuat session & E2B sandbox baru untuk: ${session_id}`);
      const sandbox = await CodeInterpreter.create({ apiKey: E2B_API_KEY });
      session = {
        sandbox,
        history: [],
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

    const sandbox = session.sandbox!;

    // 3. Setup Agent Loop dengan Gemini 2.5 Flash
    session.history.push({ role: 'user', parts: [{ text: prompt }] });

    let finalAiResponse = '';
    let stepCount = 0;
    const maxSteps = 5; // Batas eksekusi tool call berturut-turut

    while (stepCount < maxSteps) {
      stepCount++;

      // Memanggil API Gemini 2.5 Flash
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: session.history as any,
        config: {
          tools: [{ functionDeclarations: [runPythonCodeTool, readFileTool, uploadFileTool] }],
        },
      });

      const candidate = response.candidates?.[0];
      const content = candidate?.content;

      if (!content) {
        throw new Error('Tidak menerima respon dari Gemini API.');
      }

      // Masukkan respon model ke dalam chat history
      session.history.push(content as any);

      // Cek apakah ada Tool Calls / Function Calls
      const functionCalls = content.parts?.filter((p) => p.functionCall);

      if (!functionCalls || functionCalls.length === 0) {
        // Terdapat teks biasa, proses dianggap selesai
        const textPart = content.parts?.find((p) => p.text);
        finalAiResponse = textPart?.text || 'Selesai tanpa output teks.';
        break;
      }

      // Eksekusi Function Calls yang diminta
      for (const callObj of functionCalls) {
        const fc = callObj.functionCall!;
        const callName = fc.name;
        const callArgs = fc.args as Record<string, any>;
        let toolResult: any;

        logs.push(`[Tool Call] ${callName}(${JSON.stringify(callArgs)})`);

        if (callName === 'run_python_code') {
          try {
            // Eksekusi kode dengan timeout 10 detik
            const execution = await sandbox.notebook.execCell(callArgs.code, { timeoutMs: 10000 });
            
            const stdout = execution.logs.stdout.join('\n');
            const stderr = execution.logs.stderr.join('\n');
            const errorMsg = execution.error ? `${execution.error.name}: ${execution.error.value}\n${execution.error.traceback}` : '';

            toolResult = {
              stdout: stdout || undefined,
              stderr: stderr || undefined,
              error: errorMsg || undefined,
              results: execution.results.map(r => r.text || r.png || r.jpeg || r.html || r.json),
            };
          } catch (err: any) {
            toolResult = { error: `Execution error: ${err.message}` };
          }
        } else if (callName === 'read_file') {
          try {
            const content = await sandbox.files.read(callArgs.filename);
            session.lastFile = callArgs.filename;
            toolResult = { filename: callArgs.filename, content };
          } catch (err: any) {
            toolResult = { error: `Gagal membaca file: ${err.message}` };
          }
        } else if (callName === 'upload_file') {
          try {
            await sandbox.files.write(callArgs.filename, callArgs.content);
            session.lastFile = callArgs.filename;
            toolResult = { success: true, filename: callArgs.filename, message: 'File berhasil dibuat/diunggah.' };
          } catch (err: any) {
            toolResult = { error: `Gagal mengunggah file: ${err.message}` };
          }
        } else {
          toolResult = { error: `Tool ${callName} tidak dikenal.` };
        }

        // Kembalikan hasil Tool ke chat history untuk diproses Gemini pada iterasi berikutnya
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
