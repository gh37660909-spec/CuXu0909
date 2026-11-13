/**
 * Nalo Code - local API orchestration agent.
 *
 * The app ships no model and no inference. Every token comes from the user's
 * own OpenAI-compatible endpoint (Base URL + API key + model name). This file
 * is a dependency-free Node HTTP server: static UI, config, sessions, a small
 * agent loop with local tools, and SSE streaming of thinking / answer / tools.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import tls from 'node:tls';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(ROOT, 'web');
const DATA = process.env.NALO_DATA_DIR ? path.resolve(process.env.NALO_DATA_DIR) : path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');
const SESSIONS_FILE = path.join(DATA, 'sessions.json');
const ACCOUNT_FILE = path.join(DATA, 'account.json');
const AUTH_FILE = path.join(DATA, 'auth.json');
const USERS_FILE = path.join(DATA, 'users.json');
const ANNOUNCE_FILE = path.join(DATA, 'announcements.json');
const AUTOMATIONS_FILE = path.join(DATA, 'automations.json');
const MAINTENANCE_FILE = path.join(DATA, 'maintenance.json');
const CONFIGS_FILE = path.join(DATA, 'configs.json');
const DELETED_FILE = path.join(DATA, 'deleted.json');
const PROFILE_FILE = path.join(DATA, 'profile.json');
const PROFILES_FILE = path.join(DATA, 'profiles.json');
const USAGE_FILE = path.join(DATA, 'usage.json');
const USAGES_FILE = path.join(DATA, 'usages.json');
const FEEDBACK_FILE = path.join(DATA, 'feedback.jsonl');
const APP_VERSION = '2.1.9';
const LOCAL_MODEL_URL = process.env.NALO_LOCAL_URL || 'http://127.0.0.1:8090/v1';
const LOCAL_MODEL_NAME = process.env.NALO_LOCAL_MODEL || 'local';
const LOCAL_MODEL_LABEL = process.env.NALO_LOCAL_LABEL || 'Nalo start1.8pro';
const TOOLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools');
const PYTHON_BIN = process.env.NALO_PYTHON
  || (existsSync('C:\\Users\\Admin（无密码）\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe')
    ? 'C:\\Users\\Admin（无密码）\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'
    : 'python');
const DEFAULT_WORKSPACE = process.env.NALO_WORKSPACE
  ? path.resolve(process.env.NALO_WORKSPACE)
  : path.join(ROOT, 'workspace');
const PORT = Number(process.env.PORT || 5330);
const HOST = process.env.HOST || '127.0.0.1';

const MAX_TOOL_ITERATIONS = 500;
const MAX_FILE_BYTES = 400 * 1024;
const ANSWER_TIMEOUT_MS = 10 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const PLANS = {
  free: { id: 'free', name: '免费版', price: 0, concurrent: 1, devices: 1, mcp: false, automation: false, context: 32000 },
  pro: { id: 'pro', name: 'Pro 版', price: 29.9, concurrent: 3, devices: 3, mcp: true, automation: true, context: 200000 },
  max: { id: 'max', name: 'Max 版', price: 59.9, concurrent: 5, devices: 10, mcp: true, automation: true, context: 1000000 }
};

const DEFAULT_CONFIG = {
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.7,
  maxTokens: 1000000,
  systemPrompt: [
    '你是 Nalo Code 的本地 Agent，运行在用户自己的电脑上。',
    '你通过用户配置的模型 API 工作；你没有内置算力，也不要假装拥有其他工具。',
    '你需要修改代码或文件时，使用 write_file；需要了解项目时，先 list_files / read_file。\n你还可以操作浏览器（browser_open / browser_read / browser_click / browser_type / browser_screenshot）、读取图片里的文字（read_image）、读取 docx/xlsx/pptx（read_document）、创建文档（create_document，支持 docx/xlsx/pptx/txt/md/wps）、转换图片（convert_image）、修改文档（edit_document）、用本机程序打开文件（open_in_app）；写完网页后用 preview_file 直接打开预览，不要依赖本机 Python。需要交付文件时直接用 create_document 创建，不要说没有工具。用户要求画图时使用 generate_image，所有生成的文件都必须保存到当前工作区，而不是只贴在聊天里。',
    '信息不足或存在多种合理选择时，用 ask_user 提问，不要自行猜测后大改。\n遇到多步任务，先用 set_plan 列出步骤，再逐步执行；做完后用 run_command 或 read_file 验证结果，不要只说“完成了”。',
    '修改文件后说明改了哪个文件、为什么改。回答保持简洁、可执行。'
  ].join('\n'),
  workspace: DEFAULT_WORKSPACE,
  searchEnabled: false,
  thinkingLimit: 0,
  permission: 'confirm',
  agentDispatch: true,
  localModelEnabled: false,
  mcpServers: [],
  disabledTools: [],
  vision: { baseUrl: '', apiKey: '', model: '' },
  transcribe: { baseUrl: '', apiKey: '', model: '' },
  browsers: { chrome: true, edge: true },
  providers: [],
  activeProviderId: '',
  plan: 'free',
  protocol: 'openai',
  thinkingLevel: 'medium',
  contextMessages: 200,
  compressAfterTokens: 100000000
};

const BASE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出工作区某个目录下的文件与子目录。路径相对于工作区根目录，根目录用 "."。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，默认 "."' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作区内的一个文本文件。返回带行号的内容，最多 400 KB。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '在工作区内创建或覆盖一个文本文件。会自动创建父目录。内容写完后会出现在右侧工作区。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径' },
          content: { type: 'string', description: '完整文件内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '当需要用户确认方向、补全信息或在多个方案中选择时，向用户提问并等待回答。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '可选项，最多 6 个；用户可以自由输入时留空'
          }
        },
        required: ['question']
      }
    }
  }
];

const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '联网搜索。仅在用户开启联网搜索时可用，返回标题、链接和摘要。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'integer', description: '返回条数，默认 5，最多 8' }
      },
      required: ['query']
    }
  }
};

const FETCH_URL_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description: '抓取一个网页并返回正文文本（最多 6000 字符）。仅在联网搜索开启时可用。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) 地址' } },
      required: ['url']
    }
  }
};

const MEDIA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_image',
      description: '读取图片里的文字（OCR）。截图、扫描件、照片都可以；返回识别到的文字。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '图片路径' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_document',
      description: '读取文档内容：支持 pdf / docx / xlsx / pptx / txt / md / csv / json。PDF 优先读文字层，没有文字层时逐页渲染识别。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '文档路径' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_document',
      description: '创建文档：docx / xlsx / pptx / txt / md / wps。可以写标题、段落、要点、表格数据、幻灯片。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '输出路径，例如 计算机科普.docx 或 计算机科普.wps' },
          title: { type: 'string', description: '文档标题' },
          blocks: {
            type: 'array',
            description: '正文块：[{"type":"heading|paragraph|bullet","text":"...","level":1}]'
          },
          slides: { type: 'array', description: 'PPT 页：[{"title":"...","bullets":["..."]}]' },
          sheets: { type: 'array', description: 'Excel 工作表：[{"name":"Sheet1","rows":[["A1","B1"]]}]' },
          text: { type: 'string', description: '纯文本内容（txt/md 用）' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_pdf',
      description: '修改 PDF 里的文字：把 find 替换成 replace，保留原版式，输出新 PDF。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '源 PDF 路径' },
          edits: { type: 'array', description: '[{"find":"旧文字","replace":"新文字"}]' },
          target: { type: 'string', description: '可选：输出路径，默认在原文件名后加 -edited' }
        },
        required: ['path', 'edits']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_scanned_pdf',
      description: '修改扫描件/图片型 PDF 上的文字：逐页 OCR 后覆盖并重写文字，生成新 PDF。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: { type: 'array', description: '[{"find":"旧文字","replace":"新文字"}]' },
          target: { type: 'string' }
        },
        required: ['path', 'edits']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'convert_image',
      description: '转换图片格式或尺寸（jpg / png / webp / bmp）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '源图片路径' },
          target: { type: 'string', description: '输出图片路径（扩展名决定格式）' },
          width: { type: 'integer', description: '可选，目标宽度' },
          quality: { type: 'integer', description: '可选，jpg/webp 质量 1-100' }
        },
        required: ['path', 'target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: '根据文字描述生成图片（AI 绘图），保存到当前工作区并可直接打开。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图片描述' },
          size: { type: 'string', description: '尺寸，如 1024x1024' },
          filename: { type: 'string', description: '可选文件名' }
        },
        required: ['prompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_document',
      description: '修改文档：docx/pptx 支持查找替换，xlsx 支持写单元格或查找替换，txt/md/csv 支持查找替换。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文档路径' },
          edits: {
            type: 'array',
            description: '操作列表，例如 [{"find":"旧文字","replace":"新文字"}] 或 [{"sheet":"Sheet1","cell":"B2","value":123}]'
          }
        },
        required: ['path', 'edits']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_in_app',
      description: '用本机程序打开文件，例如 Word / Excel / WPS / Photoshop / Premiere；不传 app 则用默认程序。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          app: { type: 'string', description: '可选：word / excel / powerpoint / wps / photoshop / premiere' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'copy_to_desktop',
      description: 'Copy a finished file to the Windows Desktop and return the exact desktop path. Use this whenever the user asks to put the result on the desktop.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative or absolute source file' },
          name: { type: 'string', description: 'Optional output file name' }
        },
        required: ['path']
      }
    }
  }
];
const SYSTEM_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_drives',
      description: '列出这台电脑上的磁盘分区（C:、D: 等）和容量。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: '在浏览器里打开网址，可指定 chrome / edge，默认浏览器不填。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开的网址' },
          browser: { type: 'string', description: 'chrome / edge / default' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'look_screen',
      description: '截取当前屏幕并识别上面的文字，用于看用户正在做什么、看报错、看界面。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'preview_file',
      description: '在默认浏览器中预览工作区里的 HTML/PDF/图片文件；会自动启动本地预览地址，适合写完后直接运行网页。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '要预览的文件路径' } },
        required: ['path']
      }
    }
  }
];

const DEV_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在对话工作区执行 PowerShell 命令（跑测试、git、npm、python 等），返回输出。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          timeout: { type: 'integer', description: '超时毫秒，默认 120000，最大 180000' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在工作区里搜索包含某段文字的文件，返回 路径:行号:内容。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的文字或正则' },
          path: { type: 'string', description: '限定目录，默认整个工作区' },
          limit: { type: 'integer', description: '最多返回条数，默认 60' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob_files',
      description: '用通配符列出文件，例如 **/*.js 或 src/*.css。',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'glob 模式' } },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '精确修改文本文件：把 find 替换成 replace，不用重写整个文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          find: { type: 'string', description: '要查找的原文' },
          replace: { type: 'string', description: '替换成的内容' },
          all: { type: 'boolean', description: '是否替换全部，默认只替换第一处' }
        },
        required: ['path', 'find', 'replace']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_automation',
      description: 'Create a scheduled automation task for the current user. Use this when the user asks to set up a recurring or timed task.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task name' },
          prompt: { type: 'string', description: 'Full instruction to run' },
          type: { type: 'string', enum: ['once', 'interval', 'daily', 'weekly', 'manual'] },
          runAt: { type: 'string', description: 'For once: ISO date/time or milliseconds' },
          intervalMinutes: { type: 'integer' },
          time: { type: 'string', description: 'HH:MM for daily/weekly' },
          weekdays: { type: 'array', items: { type: 'integer' }, description: '0=Sunday..6=Saturday' },
          access: { type: 'string', enum: ['open', 'confirm'] }
        },
        required: ['title', 'prompt', 'type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_plan',
      description: '为多步任务列出计划步骤，之后按顺序执行；复杂任务应先调用它。',
      parameters: {
        type: 'object',
        properties: { steps: { type: 'array', items: { type: 'string' }, description: '步骤列表' } },
        required: ['steps']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: '记住一条长期信息（用户偏好、项目约定），以后每次对话都会带上。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要记住的内容' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: '读取长期记忆，可按关键词筛选。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '可选，关键词' } }
      }
    }
  }
];

const BROWSER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: '用受控浏览器打开网址，等待页面加载完成，返回标题和地址。',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_read',
      description: '读取当前浏览器页面的标题、地址和可见文字（最多 6000 字）。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: '点击页面上的元素，选择器可以是 CSS 选择器或包含文字的按钮。',
      parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' }, text: { type: 'string', description: '可选：按可见文字找按钮' } }, required: ['selector'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: '在输入框里填写文字并触发 input/change 事件。',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' }, text: { type: 'string' }, enter: { type: 'boolean', description: '可选：填完后按回车' } },
        required: ['selector', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: '截取当前浏览器页面，保存到工作区并返回路径。',
      parameters: { type: 'object', properties: {} }
    }
  }
];

const CODE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_code',
      description: '编译并运行代码，支持 Python / JavaScript / TypeScript / PowerShell / Batch / Java / C / C++ / C# / Go / Rust / PHP / Ruby / Lua / Perl。',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', description: '语言，例如 python / javascript / java / cpp' },
          code: { type: 'string', description: '代码内容（与 file 二选一）' },
          file: { type: 'string', description: '已有文件路径（与 code 二选一）' },
          args: { type: 'array', items: { type: 'string' }, description: '命令行参数' }
        },
        required: ['language']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_runtimes',
      description: '列出本机已安装和缺失的编程语言运行时。',
      parameters: { type: 'object', properties: {} }
    }
  }
];

const SERVICE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'service_start',
      description: '后台启动一个常驻进程（开发服务器、监听脚本等），返回进程 id。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          command: { type: 'string', description: 'PowerShell 命令' },
          cwd: { type: 'string', description: '可选工作目录' }
        },
        required: ['command']
      }
    }
  },
  { type: 'function', function: { name: 'service_list', description: '列出后台进程和状态。', parameters: { type: 'object', properties: {} } } },
  {
    type: 'function',
    function: {
      name: 'service_stop',
      description: '停止一个后台进程。',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'service_logs',
      description: '查看后台进程最近的输出。',
      parameters: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'integer' } }, required: ['id'] }
    }
  }
];

const EXTRA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'office_edit',
      description: '高级编辑 Office：docx 加标题/段落/表格/图片，xlsx 写单元格公式/样式/新增工作表，pptx 加幻灯片/要点/图片。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          ops: { type: 'array', description: '操作列表，见工具说明' }
        },
        required: ['path', 'ops']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'verify_project',
      description: '自动检测并运行项目测试（npm test / pytest / node --test），返回真实结果。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_image',
      description: '用视觉模型理解图片内容（需要先在设置里配置视觉模型）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, question: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'media_info',
      description: '查看音频/视频文件的时长、分辨率等信息。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'transcribe_audio',
      description: '转写音频/视频里的语音（需要先在设置里配置转写模型）。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: '等待页面上出现某个元素或文字。',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' }, text: { type: 'string' }, timeout: { type: 'integer' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_press',
      description: '在当前焦点元素上按键，例如 Enter、Tab、Escape。',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: '滚动页面。',
      parameters: { type: 'object', properties: { y: { type: 'integer' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_upload',
      description: '给页面上的文件上传控件选择本地文件。',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } },
        required: ['selector', 'paths']
      }
    }
  }
];

const SENSITIVE_TOOLS = new Set(['edit_scanned_pdf', 'office_edit', 'transcribe_audio', 'browser_upload', 'service_start', 'service_stop', 'run_code', 'list_runtimes', 'list_files', 'read_file', 'write_file', 'read_image', 'read_document', 'edit_pdf', 'convert_image', 'generate_image', 'edit_document', 'list_drives', 'open_url', 'look_screen', 'run_command', 'search_files', 'glob_files', 'edit_file', 'browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_screenshot']);

function allToolDefinitions() {
  const tools = [...BASE_TOOLS, ...MEDIA_TOOLS, ...SYSTEM_TOOLS, ...BROWSER_TOOLS, ...DEV_TOOLS, ...CODE_TOOLS, ...SERVICE_TOOLS, ...EXTRA_TOOLS, ...(config.plan === 'free' ? [] : mcpToolDefinitions())];
  if (config.searchEnabled) tools.push(WEB_SEARCH_TOOL, FETCH_URL_TOOL);
  return tools;
}

function buildTools() {
  const disabled = new Set(Array.isArray(config.disabledTools) ? config.disabledTools : []);
  return allToolDefinitions().filter((tool) => !disabled.has(tool.function?.name));
}

const TOOL_GROUPS = [
  { id: 'files', label: '文件', description: '查看、读取、写入工作区里的文件', names: ['list_files', 'read_file', 'write_file'] },
  { id: 'documents', label: '文档办公', description: 'WPS / Word / Excel / PPT / PDF 的读取、创建与修改', names: ['read_document', 'create_document', 'edit_document', 'edit_pdf', 'edit_scanned_pdf'] },
  { id: 'images', label: '图片', description: '扫描图片文字、转换图片格式', names: ['read_image', 'convert_image', 'generate_image'] },
  { id: 'browsers', label: '浏览器', description: '允许 Agent 调用的浏览器', names: [] },
  { id: 'browserops', label: '浏览器操作', description: '打开网页、点按钮、填表单、截图', names: ['browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_screenshot', 'preview_file'] },
  { id: 'system', label: '系统与屏幕', description: '打开浏览器 / 程序、查看磁盘、截屏读屏', names: ['open_in_app', 'open_url', 'list_drives', 'look_screen', 'preview_file'] },
  { id: 'web', label: '联网', description: '网页搜索与抓取（需在插件里开启联网搜索）', names: ['web_search', 'fetch_url'] },
  { id: 'office', label: 'Office 高级编辑', description: 'Word/Excel/PPT 深度修改', names: ['office_edit'] },
  { id: 'verify', label: '验证', description: '自动跑测试', names: ['verify_project'] },
  { id: 'vision', label: '视觉与媒体', description: '看图、音视频信息与转写', names: ['analyze_image', 'media_info', 'transcribe_audio'] },
  { id: 'services', label: '进程与服务', description: '后台常驻进程', names: ['service_start', 'service_list', 'service_stop', 'service_logs'] },
  { id: 'code', label: '代码编译', description: '编译运行 15 种语言', names: ['run_code', 'list_runtimes'] },
  { id: 'dev', label: '开发与命令', description: '执行命令、搜索代码、修改文件', names: ['run_command', 'search_files', 'glob_files', 'edit_file', 'set_plan'] },
  { id: 'memory', label: '长期记忆', description: '记住偏好与约定', names: ['remember', 'recall'] },
  { id: 'ask', label: '交互', description: '需要你确认时提问', names: ['ask_user'] },
  { id: 'automation', label: '自动化', description: '创建定时/间隔任务', names: ['create_automation'] }
];

function toolCatalog() {
  const disabled = new Set(Array.isArray(config.disabledTools) ? config.disabledTools : []);
  const defs = new Map(allToolDefinitions().map((tool) => [tool.function.name, tool.function]));
  const groups = TOOL_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    description: group.description,
    tools: group.names.filter((name) => defs.has(name)).map((name) => ({
      name,
      label: defs.get(name).description || name,
      enabled: !disabled.has(name)
    }))
  })).filter((group) => group.tools.length);
  const mcpTools = [...defs.keys()].filter((name) => name.startsWith('mcp__')).map((name) => ({
    name,
    label: defs.get(name).description || name,
    enabled: !disabled.has(name)
  }));
  if (mcpTools.length) groups.push({ id: 'mcp', label: 'MCP 工具', description: '来自已连接 MCP 服务的工具', tools: mcpTools });
  return groups;
}

function driveOf(target) {
  const root = path.parse(path.resolve(target)).root;
  return root ? root.replace(/\\$/, '') : '';
}

async function webSearch(query, count = 5) {
  const limit = Math.max(1, Math.min(8, Number(count) || 5));
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(endpoint, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NaloCode/1.1.2',
        accept: 'text/html'
      },
      signal: controller.signal
    });
    if (!response.ok) return `搜索失败：HTTP ${response.status}`;
    const html = await response.text();
    const results = [];
    const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets = [...html.matchAll(snippetPattern)].map((m) => stripTags(m[1]));
    let match;
    while ((match = linkPattern.exec(html)) && results.length < limit) {
      const url = decodeURIComponent(match[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '').split('&rut=')[0]);
      results.push(`${results.length + 1}. ${stripTags(match[2])}\n   ${url}\n   ${snippets[results.length] || ''}`.trim());
    }
    return results.length ? results.join('\n\n') : '没有找到结果';
  } catch (error) {
    return `搜索不可用：${error.message}`;
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchUrlText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const target = new URL(String(url));
    if (!/^https?:$/.test(target.protocol)) return '只支持 http/https 地址';
    const response = await fetch(target, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NaloCode/1.1.2' },
      signal: controller.signal
    });
    if (!response.ok) return `抓取失败：HTTP ${response.status}`;
    const text = await response.text();
    const body = text.length > 80000 ? text.slice(0, 80000) : text;
    const clean = stripTags(body);
    return clean.slice(0, 6000) || '页面没有可读文本';
  } catch (error) {
    return `抓取不可用：${error.message}`;
  } finally {
    clearTimeout(timer);
  }
}



/* ------------------------------------------------- audit / share / tasks */

let auditLog = [];
try {
  const raw = await fs.readFile(path.join(DATA, 'audit.jsonl'), 'utf8');
  auditLog = raw.split('\n').filter(Boolean).slice(-2000).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
} catch { auditLog = []; }

async function audit(entry) {
  const record = { at: Date.now(), ...entry };
  auditLog.push(record);
  if (auditLog.length > 2000) auditLog.shift();
  try {
    await fs.mkdir(DATA, { recursive: true });
    await fs.appendFile(path.join(DATA, 'audit.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  } catch { /* ignore */ }
}

let shares = {};
try { shares = JSON.parse(await fs.readFile(path.join(DATA, 'shares.json'), 'utf8')); } catch { shares = {}; }

async function saveShares() {
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(path.join(DATA, 'shares.json'), JSON.stringify(shares, null, 2), 'utf8');
}

const services = new Map();

async function startService({ name, command, cwd }) {
  const id = crypto.randomUUID().slice(0, 8);
  const logFile = path.join(DATA, 'logs', `${id}.log`);
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const stream = (await import('node:fs')).createWriteStream(logFile, { flags: 'a' });
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: cwd || config.workspace,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  const service = { id, name: name || command.slice(0, 40), command, child, logFile, startedAt: Date.now(), status: 'running' };
  child.on('exit', (code) => { service.status = `exited(${code})`; });
  services.set(id, service);
  return service;
}

function listServices() {
  return [...services.values()].map((item) => ({
    id: item.id, name: item.name, command: item.command, status: item.status, startedAt: item.startedAt, logFile: item.logFile
  }));
}

const backgroundTasks = new Map();
const activeRuns = new Map();
const queuedChats = new Map();

async function startBackgroundTask({ sessionId, message }) {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error('对话不存在');
  const taskId = crypto.randomUUID().slice(0, 8);
  const task = { id: taskId, sessionId, status: 'running', startedAt: Date.now(), output: '', events: [] };
  backgroundTasks.set(taskId, task);
  const emit = (event, payload) => {
    task.events.push({ event, at: Date.now() });
    if (event === 'content') task.output += payload.text || '';
  };
  (async () => {
    try {
      await runAgent({ session, runId: taskId, emit, signal: new AbortController().signal });
      task.status = 'done';
    } catch (error) {
      task.status = 'error';
      task.error = error.message;
    } finally {
      task.finishedAt = Date.now();
    }
  })();
  return task;
}

/* ------------------------------------------------------------ MCP client */

class McpClient {
  constructor(server) {
    this.server = server;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.tools = [];
    this.status = 'idle';
    this.error = '';
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || 'MCP 调用失败'));
        else resolve(message.result);
      }
    }
  }

  send(payload) {
    if (!this.child) throw new Error('MCP 未连接');
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP 请求超时：${method}`));
        }
      }, 25000);
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async start() {
    this.status = 'connecting';
    const child = spawn(this.server.command, Array.isArray(this.server.args) ? this.server.args : [], {
      env: { ...process.env, ...(this.server.env || {}) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.on('data', () => {});
    child.on('exit', () => {
      const wasConnected = this.status === 'connected';
      this.child = null;
      this.status = wasConnected ? 'stopped' : 'error';
      for (const { reject } of this.pending.values()) reject(new Error('MCP 进程已退出'));
      this.pending.clear();
    });
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Nalo Code', version: APP_VERSION }
    });
    this.notify('notifications/initialized', {});
    const listed = await this.request('tools/list', {});
    this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
    this.status = 'connected';
    this.error = '';
    return this.tools;
  }

  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args || {} });
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts.map((part) => part?.text || (part?.type ? `[${part.type}]` : '')).filter(Boolean).join('\n');
    return text || JSON.stringify(result);
  }

  close() {
    try { this.child?.kill(); } catch { /* ignore */ }
    this.child = null;
    this.status = 'stopped';
    this.tools = [];
  }
}

const mcpClients = new Map();

async function ensureMcpClients() {
  const servers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
  for (const [name, client] of [...mcpClients]) {
    if (!servers.some((item) => item.name === name && item.enabled !== false)) {
      client.close();
      mcpClients.delete(name);
    }
  }
  for (const item of servers) {
    if (item.enabled === false || mcpClients.has(item.name)) continue;
    const client = new McpClient(item);
    mcpClients.set(item.name, client);
    try {
      await client.start();
    } catch (error) {
      client.error = error.message;
      client.status = 'error';
    }
  }
}

function mcpToolDefinitions() {
  const tools = [];
  for (const [serverName, client] of mcpClients) {
    if (client.status !== 'connected') continue;
    for (const tool of client.tools) {
      tools.push({
        type: 'function',
        function: {
          name: `mcp__${serverName}__${tool.name}`,
          description: `[MCP ${serverName}] ${tool.description || tool.name}`,
          parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema
            : { type: 'object', properties: {} }
        }
      });
    }
  }
  return tools;
}



/* ------------------------------------------------------- code runtimes */

const CODE_LANGUAGES = {
  python: { label: 'Python', ext: 'py', run: [PYTHON_BIN, '{file}'], probe: PYTHON_BIN, install: 'winget install Python.Python.3.12' },
  javascript: { label: 'JavaScript', ext: 'js', run: ['node', '{file}'], probe: 'node', install: 'winget install OpenJS.NodeJS' },
  typescript: { label: 'TypeScript', ext: 'ts', run: ['node', '--experimental-strip-types', '{file}'], probe: 'node', install: 'winget install OpenJS.NodeJS' },
  powershell: { label: 'PowerShell', ext: 'ps1', run: ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '{file}'], probe: 'powershell.exe' },
  batch: { label: 'Batch', ext: 'bat', run: ['cmd.exe', '/c', '{file}'], probe: 'cmd.exe' },
  java: { label: 'Java', ext: 'java', compile: ['javac', '{file}'], run: ['java', '-cp', '{dir}', '{class}'], probe: 'javac', install: 'winget install Microsoft.OpenJDK.21' },
  c: { label: 'C', ext: 'c', compile: ['gcc', '{file}', '-o', '{exe}'], run: ['{exe}'], probe: 'gcc', install: 'winget install BrechtSanders.WinLibs.POSIX.UCRT' },
  cpp: { label: 'C++', ext: 'cpp', compile: ['g++', '{file}', '-o', '{exe}'], run: ['{exe}'], probe: 'g++', install: 'winget install BrechtSanders.WinLibs.POSIX.UCRT' },
  csharp: { label: 'C#', ext: 'cs', compile: ['csc', '/nologo', `/out:{exe}`, '{file}'], run: ['{exe}'], probe: 'csc', install: 'winget install Microsoft.DotNet.SDK.8' },
  go: { label: 'Go', ext: 'go', run: ['go', 'run', '{file}'], probe: 'go', install: 'winget install GoLang.Go' },
  rust: { label: 'Rust', ext: 'rs', compile: ['rustc', '{file}', '-o', '{exe}'], run: ['{exe}'], probe: 'rustc', install: 'winget install Rustlang.Rustup' },
  php: { label: 'PHP', ext: 'php', run: ['php', '{file}'], probe: 'php', install: 'winget install PHP.PHP' },
  ruby: { label: 'Ruby', ext: 'rb', run: ['ruby', '{file}'], probe: 'ruby', install: 'winget install RubyInstallerTeam.Ruby' },
  lua: { label: 'Lua', ext: 'lua', run: ['lua', '{file}'], probe: 'lua', install: 'winget install DEVCOM.Lua' },
  perl: { label: 'Perl', ext: 'pl', run: ['perl', '{file}'], probe: 'perl', install: 'winget install StrawberryPerl.StrawberryPerl' }
};

const runtimeCache = new Map();

function probeCommand(command, args = ['--version'], timeout = 2500) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(null); }, timeout);
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 || output ? output.split('\n')[0].trim().slice(0, 80) : null);
    });
  });
}

async function runtimeInfo(language) {
  const def = CODE_LANGUAGES[language];
  if (!def) return null;
  if (runtimeCache.has(language)) return runtimeCache.get(language);
  const version = await probeCommand(def.probe);
  const info = { language, label: def.label, available: Boolean(version), version: version || '', install: def.install || '' };
  runtimeCache.set(language, info);
  return info;
}

async function runtimes() {
  return Promise.all(Object.keys(CODE_LANGUAGES).map((language) => runtimeInfo(language)));
}

function fillCommand(template, values) {
  return template.map((part) => part.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? ''));
}

async function runCode({ language, code, file, args, stdin }) {
  const def = CODE_LANGUAGES[language];
  if (!def) throw new Error(`不支持的语言：${language}`);
  const info = await runtimeInfo(language);
  if (!info.available) throw new Error(`${def.label} 运行时未安装${def.install ? `，可执行：${def.install}` : ''}`);

  const runDir = path.join(config.workspace, '.runs', String(Date.now()));
  await fs.mkdir(runDir, { recursive: true });
  let sourcePath;
  if (code && String(code).trim()) {
    const base = path.basename(String(file || `main.${def.ext}`)).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
    const name = base.endsWith(`.${def.ext}`) ? base : `${base}.${def.ext}`;
    sourcePath = path.join(runDir, name);
    await fs.writeFile(sourcePath, String(code), 'utf8');
  } else if (file) {
    sourcePath = resolveTarget(file, config.workspace);
    runDir = path.dirname(sourcePath);
  } else {
    throw new Error('需要提供 code 或 file');
  }

  const className = path.basename(sourcePath, path.extname(sourcePath));
  const exeName = process.platform === 'win32' ? `${className}.exe` : className;
  const exePath = path.join(runDir, exeName);
  const values = { file: sourcePath, dir: runDir, class: className, exe: exePath };

  let compileOutput = '';
  if (def.compile) {
    compileOutput = await runProcess(def.compile[0], fillCommand(def.compile.slice(1), values), { cwd: runDir, timeout: 180000 }).catch((error) => {
      throw new Error(`编译失败：${error.message}`);
    });
  }

  const command = fillCommand(def.run, values);
  const output = await runProcess(command[0], command.slice(1), { cwd: runDir, timeout: 120000 }).catch((error) => {
    throw new Error(`运行失败：${error.message}`);
  });

  const parts = [];
  if (compileOutput) parts.push(`[编译]\n${compileOutput}`);
  parts.push(`[运行]\n${output || '（无输出）'}`);
  return parts.join('\n\n').slice(0, 12000);
}

/* ---------------------------------------------------------- browser (CDP) */

const BROWSER_PORT = Number(process.env.NALO_BROWSER_PORT) || 9333;
const BROWSER_PROFILE = path.join(os.tmpdir(), 'nalo-browser-profile');
const BROWSER_CANDIDATES = [
  process.env.NALO_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

let browserClient = null;

function browserReady() {
  return browserClient && browserClient.ws && browserClient.ws.readyState === 1;
}

async function browserVersion() {
  try {
    const response = await fetch(`http://127.0.0.1:${BROWSER_PORT}/json/version`, { signal: AbortSignal.timeout(800) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

async function ensureBrowser() {
  if (browserReady()) return browserClient;
  if (!(await browserVersion())) {
    const executable = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
    if (!executable) throw new Error('没有找到 Chrome 或 Edge');
    spawn(executable, [
      `--remote-debugging-port=${BROWSER_PORT}`,
      `--user-data-dir=${BROWSER_PROFILE}`,
      '--no-first-run', '--no-default-browser-check', '--window-size=1440,900',
      'about:blank'
    ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (await browserVersion()) break;
    }
  }
  const targets = await (await fetch(`http://127.0.0.1:${BROWSER_PORT}/json/list`)).json();
  const page = targets.find((item) => item.type === 'page');
  if (!page) throw new Error('浏览器没有可用的页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const client = { ws, nextId: 0, pending: new Map() };
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && client.pending.has(message.id)) {
      const { resolve, reject } = client.pending.get(message.id);
      client.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  client.send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++client.nextId;
    client.pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (client.pending.has(id)) {
        client.pending.delete(id);
        reject(new Error(`浏览器请求超时：${method}`));
      }
    }, 30000);
  });
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  browserClient = client;
  return client;
}

async function browserEvaluate(expression) {
  const client = await ensureBrowser();
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行失败');
  }
  return result.result.value;
}

async function browserNavigate(url) {
  const client = await ensureBrowser();
  await client.send('Page.navigate', { url });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const ready = await browserEvaluate('document.readyState');
    if (ready === 'complete') break;
  }
  return browserEvaluate('({ title: document.title, url: location.href })');
}


/* ------------------------------------------------------------------ state */

let config = { ...DEFAULT_CONFIG };
let sessions = [];
let account = null;        // { username, salt, hash }
let users = [];             // registered users
let userConfigs = {};      // per-user model/API config
let userUsages = {};       // per-user token usage
let announcements = [];    // admin announcements
let automations = [];      // scheduled automation tasks
let automationRuns = [];   // automation run history
let maintenanceState = { enabled: false, message: '系统维护中，请稍后再试。' };
let profile = { nickname: '', birthDate: '', gender: 'private', avatar: '', updatedAt: 0 };
let profiles = {};
let usage = { promptTokens: 0, completionTokens: 0, updatedAt: 0, days: {} };
const authTokens = new Map(); // token -> expiry (ms)
let deletedState = { ids: [], allAt: 0 };

async function saveAuthTokens() {
  try {
    await fs.mkdir(DATA, { recursive: true });
    await fs.writeFile(AUTH_FILE, JSON.stringify(Object.fromEntries(authTokens), null, 2), 'utf8');
  } catch { }
}
const runs = new Map();      // runId -> { controller, pending }
const previews = new Map();  // token -> { path, exp }
const pendingQuestions = new Map(); // questionId -> resolve

async function ensureData() {
  await fs.mkdir(DATA, { recursive: true });
  await fs.mkdir(config.workspace || DEFAULT_WORKSPACE, { recursive: true });
}


function automationFileData() {
  return { tasks: automations, runs: automationRuns.slice(0, 500) };
}
async function saveAutomations() {
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(AUTOMATIONS_FILE, JSON.stringify(automationFileData(), null, 2), 'utf8');
}
function automationNextRun(task, from = Date.now()) {
  if (!task || task.enabled === false) return null;
  const type = task.type || 'once';
  if (type === 'manual') return null;
  if (type === 'once') return Number(task.runAt) > from ? Number(task.runAt) : null;
  if (type === 'interval') {
    const every = Math.max(1, Number(task.intervalMinutes) || 60) * 60000;
    let next = Number(task.lastRunAt) || Number(task.createdAt) || from;
    while (next <= from) next += every;
    return next;
  }
  const [hh, mm] = String(task.time || '09:00').split(':').map(Number);
  const make = (day) => {
    const d = new Date(day);
    d.setHours(Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0, 0, 0);
    return d.getTime();
  };
  const today = new Date(from);
  today.setHours(0, 0, 0, 0);
  if (type === 'daily') {
    let next = make(today.getTime());
    if (next <= from) next = make(today.getTime() + 86400000);
    return next;
  }
  if (type === 'weekly') {
    const days = Array.isArray(task.weekdays) && task.weekdays.length ? task.weekdays.map(Number) : [1, 2, 3, 4, 5];
    for (let i = 0; i < 14; i += 1) {
      const day = today.getTime() + i * 86400000;
      if (!days.includes(new Date(day).getDay())) continue;
      const next = make(day);
      if (next > from) return next;
    }
  }
  return null;
}
function automationSummary(task) {
  const type = task.type || 'once';
  if (type === 'once') return task.runAt ? new Date(Number(task.runAt)).toLocaleString() : '一次性';
  if (type === 'interval') return `每 ${Math.max(1, Number(task.intervalMinutes) || 60)} 分钟`;
  if (type === 'daily') return `每天 ${task.time || '09:00'}`;
  if (type === 'weekly') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${(task.weekdays || [1, 2, 3, 4, 5]).map((d) => names[d] || '').join('、')} ${task.time || '09:00'}`;
  }
  return '手动';
}
const automationRunning = new Set();
const automationControllers = new Map();
async function createAutomationSession(task) {
  const session = {
    id: crypto.randomUUID(), owner: task.owner || '', title: `自动化：${task.title}`,
    createdAt: Date.now(), updatedAt: Date.now(),
    messages: [{ role: 'user', content: task.prompt }],
    automationId: task.id
  };
  await ensureSessionWorkspace(session);
  sessions.unshift(session);
  task.lastSessionId = session.id;
  await saveAutomations();
  saveSessionsSoon();
  return session;
}

async function runAutomation(task, trigger = 'schedule', presetSession = null) {
  if (!task || automationRunning.has(task.id)) return;
  automationRunning.add(task.id);
  const run = { id: crypto.randomUUID(), taskId: task.id, owner: task.owner || '', title: task.title, trigger, status: 'running', startedAt: Date.now(), output: '', sessionId: '', tools: [], approval: null };
  automationRuns.unshift(run);
  task.lastRunAt = Date.now();
  task.lastStatus = 'running';
  task.lastError = '';
  task.nextRunAt = null;
  const controller = new AbortController();
  automationControllers.set(task.id, controller);
  await saveAutomations();
  try {
    const session = presetSession || await createAutomationSession(task);
    run.sessionId = session.id;
    task.lastSessionId = session.id;
    await saveAutomations().catch(() => {});
    const emit = (event, payload) => {
      if (event === 'content' && payload?.text) run.output += payload.text;
      if (event === 'error') run.error = payload?.message || '';
      if (event === 'tool-start' && payload?.name) run.tools.push(payload.name);
      if (event === 'approval') run.approval = { id: payload.id, tool: payload.tool, summary: payload.summary, location: payload.location };
      if (event === 'tool-end') run.approval = null;
    };
    await runAgent({ session, runId: run.id, emit, signal: controller.signal, autoApprove: task.access !== 'confirm', automationMode: true });
    if (!run.output.trim()) {
      const note = '自动化任务已完成，工具执行结果已保存在工作区。';
      run.output = note;
      session.messages.push({ role: 'assistant', content: note });
      session.updatedAt = Date.now();
    }
    run.status = 'done';
    task.lastStatus = 'done';
    task.lastSessionId = session.id;
  } catch (error) {
    run.status = error?.name === 'AbortError' ? 'stopped' : 'error';
    run.error = error?.name === 'AbortError' ? '已暂停' : error.message;
    task.lastStatus = run.status;
    task.lastError = run.error;
  } finally {
    run.finishedAt = Date.now();
    if ((task.type || 'once') === 'once') task.enabled = false;
    task.nextRunAt = automationNextRun(task, Date.now());
    task.lastStatus = task.lastStatus || 'done';
    automationRunning.delete(task.id);
    automationControllers.delete(task.id);
    automationRuns = automationRuns.slice(0, 500);
    await saveAutomations().catch(() => {});
    saveSessionsSoon();
  }
}
function startAutomationScheduler() {
  setInterval(() => {
    const now = Date.now();
    for (const task of automations) {
      if (!task.enabled || task.nextRunAt == null) continue;
      if (task.nextRunAt <= now) runAutomation(task, 'schedule').catch(() => {});
    }
  }, 5000).unref?.();
}
async function loadState() {
  await recoverPendingUpdate();
  try {
    const raw = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
    config = { ...DEFAULT_CONFIG, ...raw };
  } catch { /* first run */ }
  try {
    sessions = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
    for (const item of sessions) {
      if (!Array.isArray(item.messages)) continue;
      const fixed = [];
      for (let i = 0; i < item.messages.length; i += 1) {
        const current = item.messages[i];
        const next = item.messages[i + 1];
        if (current.role === 'assistant' && !(current.tool_calls || []).length && current.content
          && next && next.role === 'assistant' && (next.tool_calls || []).length && next.content === current.content) continue;
        if (current.role === 'assistant' && (current.tool_calls || []).length && current.content
          && next && next.role === 'assistant' && !(next.tool_calls || []).length && next.content === current.content) {
          fixed.push(next); i += 1; continue;
        }
        fixed.push(current);
      }
      item.messages = fixed;
    }
    sessions = sessions.filter((item) => item.automationId || (!deletedState.ids.includes(item.id) && (item.updatedAt || 0) > deletedState.allAt));
    try {
      const deleted = JSON.parse(await fs.readFile(DELETED_FILE, 'utf8'));
      deletedState = { ids: Array.isArray(deleted.ids) ? deleted.ids : [], allAt: Number(deleted.allAt) || 0 };
      sessions = sessions.filter((item) => item.automationId || (!deletedState.ids.includes(item.id) && (item.updatedAt || 0) > deletedState.allAt));
    } catch { }
    if (!Array.isArray(sessions)) sessions = [];
  } catch { sessions = []; }
  try { account = JSON.parse(await fs.readFile(ACCOUNT_FILE, 'utf8')); } catch { account = null; }
  await loadUsers();
  try {
    announcements = JSON.parse(await fs.readFile(ANNOUNCE_FILE, 'utf8'));
    if (!Array.isArray(announcements)) announcements = [];
    try {
      const auto = JSON.parse(await fs.readFile(AUTOMATIONS_FILE, 'utf8'));
      automations = Array.isArray(auto.tasks) ? auto.tasks : [];
      automationRuns = Array.isArray(auto.runs) ? auto.runs : [];
    } catch { automations = []; automationRuns = []; }
    try {
      const saved = JSON.parse(await fs.readFile(MAINTENANCE_FILE, 'utf8'));
      maintenanceState = { enabled: Boolean(saved.enabled), message: String(saved.message || '系统维护中，请稍后再试。').slice(0, 500) };
    } catch { }
  } catch { announcements = []; }
  try {
    userConfigs = JSON.parse(await fs.readFile(CONFIGS_FILE, 'utf8'));
    if (!userConfigs || typeof userConfigs !== 'object' || Array.isArray(userConfigs)) userConfigs = {};
  } catch { userConfigs = {}; }
  if (account) {
    if (!userConfigs[account.username]) userConfigs[account.username] = { ...config };
    applyUserConfig(account.username);
  }
try {
  const saved = JSON.parse(await fs.readFile(AUTH_FILE, 'utf8'));
  for (const [token, record] of Object.entries(saved)) {
    if (record && typeof record === 'object' && Number(record.exp) > Date.now() && record.username) {
      authTokens.set(token, { exp: Number(record.exp), username: record.username });
    } else if (Number(record) > Date.now()) {
      authTokens.set(token, { exp: Number(record), username: account?.username || '' });
    }
  }
} catch { }
  try {
    const stored = JSON.parse(await fs.readFile(PROFILE_FILE, 'utf8'));
    profile = { ...profile, ...stored };
  } catch { /* defaults */ }
  try {
    profiles = JSON.parse(await fs.readFile(PROFILES_FILE, 'utf8'));
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) profiles = {};
  } catch { profiles = {}; }
  if (!Object.keys(profiles).length && (profile.nickname || account?.username)) {
    const owner = profile.nickname && profile.nickname !== account?.username ? profile.nickname : account.username;
    if (owner) profiles[owner] = { ...profile };
  }
  if (account) {
    profiles[account.username] ||= { nickname: account.username, birthDate: '', gender: 'private', avatar: '', updatedAt: Date.now() };
    applyProfile(account.username);
  }
  try {
    const stored = JSON.parse(await fs.readFile(USAGE_FILE, 'utf8'));
    usage = { ...usage, ...stored };
    if (!usage.days || typeof usage.days !== 'object') usage.days = {};
  } catch { /* defaults */ }
  try {
    userUsages = JSON.parse(await fs.readFile(USAGES_FILE, 'utf8'));
    if (!userUsages || typeof userUsages !== 'object' || Array.isArray(userUsages)) userUsages = {};
  } catch { userUsages = {}; }
  if (account) {
    if (!userUsages[account.username]) userUsages[account.username] = { ...usage };
    applyUserUsage(account.username);
  }
  if (!config.workspace) config.workspace = DEFAULT_WORKSPACE;
  config.contextMessages = 0;
  if (!Number(config.compressAfterTokens)) config.compressAfterTokens = 100000000;
}


/* --------------------------------------------------------------- license */

const LICENSE_FILE = path.join(DATA, 'license.json');
const LICENSE_CONFIG_FILE = path.join(DATA, 'license-config.json');

let licenseConfig = null;
try { licenseConfig = JSON.parse(await fs.readFile(LICENSE_CONFIG_FILE, 'utf8')); } catch { licenseConfig = null; }

const deviceId = crypto.createHash('sha256')
  .update(`${os.hostname()}|${Object.values(os.networkInterfaces()).flat().filter((item) => item && item.mac).map((item) => item.mac).join(',')}`)
  .digest('hex').slice(0, 32);

let licenseState = { token: '', key: '', lastCheck: 0, lastLogin: 0, maintenance: false, revoked: false, reason: '' };
try { licenseState = { ...licenseState, ...JSON.parse(await fs.readFile(LICENSE_FILE, 'utf8')) }; } catch { /* fresh */ }

async function saveLicenseState() {
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(LICENSE_FILE, JSON.stringify(licenseState, null, 2), 'utf8');
}

function verifyLicenseToken(token) {
  try {
    const [body, signature] = String(token || '').split('.');
    if (!body || !signature || !licenseConfig?.publicKey) return null;
    const ok = crypto.verify(null, Buffer.from(body), licenseConfig.publicKey, Buffer.from(signature, 'base64url'));
    if (!ok) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch { return null; }
}

function licenseSummary() {
  const required = Boolean(licenseConfig?.required);
  const payload = verifyLicenseToken(licenseState.token);
  const graceDays = Number(licenseConfig?.graceDays ?? 3);
  const offlineWindow = Math.max(graceDays * 86400e3, 10 * 60e3);
  const offlineUntil = licenseState.lastCheck ? licenseState.lastCheck + offlineWindow : 0;
  const loginAge = licenseState.lastLogin ? Date.now() - licenseState.lastLogin : Infinity;
  const loginValid = loginAge <= 3 * 86400e3;
  let licensed = !required;
  let reason = '';
  if (required) {
    if (adminBypass) { licensed = true; reason = '管理员模式'; }
    else if (licenseState.revoked) { licensed = false; reason = licenseState.reason || '账号已被停用'; }
    else if (!payload) { licensed = false; reason = '尚未登录'; }
    else if (licenseState.maintenance) { licensed = false; reason = licenseState.reason || '研发团队正在进行功能维护'; }
    else if (sessionVerified) { licensed = true; reason = ''; }
    else if (!loginValid) { licensed = false; reason = '超过 3 天未登录，请重新登录'; }
    else licensed = true;
  }
  return {
    required, licensed, reason,
    exp: payload?.exp || 0,
    lastCheck: licenseState.lastCheck,
    graceDays,
    autoActivate: Boolean(licenseConfig?.autoActivate),
    maintenance: Boolean(licenseState.maintenance),
    admin: adminBypass,
    phoneRegister: Boolean(licenseConfig?.phoneRegister),
    device: deviceId,
    server: licenseConfig?.serverUrl || '',
    key: licenseState.key ? `${licenseState.key.slice(0, 6)}…` : ''
  };
}

async function vendorPost(pathname, payload, timeout = 15000) {
  if (!licenseConfig?.serverUrl) throw new Error('未配置授权服务器');
  const response = await fetch(`${licenseConfig.serverUrl.replace(/\/$/, '')}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout)
  });
  return response.json();
}

async function licenseCaptcha() {
  if (!licenseConfig?.serverUrl) throw new Error('未配置授权服务器');
  const response = await fetch(`${licenseConfig.serverUrl.replace(/\/$/, '')}/captcha`, { signal: AbortSignal.timeout(10000) });
  return response.json();
}

async function licenseSendSms(body) {
  return vendorPost('/sms/send', { phone: body.phone, captchaId: body.captchaId, captchaAnswer: body.captchaAnswer });
}

async function licenseRegister(body) {
  const data = await vendorPost('/register', { phone: body.phone, code: body.code, device: deviceId });
  if (!data.ok) throw new Error(data.reason || '注册失败');
  if (!verifyLicenseToken(data.token)) throw new Error('许可证签名无效');
  licenseState = { token: data.token, key: data.key || '', lastCheck: Date.now(), lastLogin: Date.now(), maintenance: false, revoked: false, reason: '' };
  await saveLicenseState();
  sessionVerified = true;
  licenseCache = { at: Date.now(), summary: licenseSummary() };
  openControlStream();
  return licenseSummary();
}

let licenseCache = { at: 0, summary: null };
let sessionVerified = false;
let controlAbort = null;
let adminBypass = false;

function setMaintenance(reason) {
  licenseState.maintenance = true;
  licenseState.reason = reason || '研发团队正在进行功能维护';
  sessionVerified = false;
}

function clearMaintenance() {
  licenseState.maintenance = false;
  licenseState.reason = '';
}

async function openControlStream() {
  if (!licenseConfig?.serverUrl || !licenseState.token || controlAbort || adminBypass) return;
  controlAbort = new AbortController();
  const token = licenseState.token;
  (async () => {
    try {
      const response = await fetch(`${licenseConfig.serverUrl.replace(/\/$/, '')}/events?token=${encodeURIComponent(token)}`, {
        headers: { accept: 'text/event-stream' },
        signal: controlAbort.signal
      });
      if (!response.ok || !response.body) throw new Error('control stream failed');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = raw.match(/^event:\s*(.+)$/m)?.[1];
          if (process.env.NALO_DEBUG) console.error('[control]', event);
          if (event === 'maintenance') setMaintenance('研发团队正在进行功能维护');
          else if (event === 'resume') { licenseState.maintenance = false; licenseState.reason = ''; }
          else if (event === 'revoked') { licenseState.revoked = true; licenseState.reason = '账号已被停用'; }
        }
      }
    } catch (error) {
      if (process.env.NALO_DEBUG) console.error('[control] closed', error.message);
    } finally {
      controlAbort = null;
    }
  })();
}

async function ensureSession(force = false) {
  if (!licenseConfig?.required) return licenseSummary();
  if (adminBypass) return licenseSummary();
  if (licenseState.maintenance) return licenseSummary();
  if (sessionVerified) return licenseSummary();
  if (!licenseState.token) {
    clearMaintenance();
    if (licenseConfig.autoActivate) {
      try {
        const summary = await autoActivateLicense();
        sessionVerified = true;
        openControlStream();
        return summary;
      } catch { /* fall through to login screen */ }
    }
    return licenseSummary();
  }
  const recent = licenseState.lastLogin && Date.now() - licenseState.lastLogin <= 3 * 86400e3;
  if (recent && !force) {
    sessionVerified = true;
    clearMaintenance();
    openControlStream();
    return licenseSummary();
  }
  try {
    const data = await vendorPost('/session', { token: licenseState.token }, 8000);
    if (!data.ok) {
      if (data.maintenance) setMaintenance(data.reason);
      else if (data.revoked) { licenseState.revoked = true; licenseState.reason = data.reason || '账号已被停用'; }
      else { licenseState.reason = data.reason || '登录已过期，请重新登录'; }
      return licenseSummary();
    }
    sessionVerified = true;
    licenseState.lastLogin = Date.now();
    await saveLicenseState();
    clearMaintenance();
    openControlStream();
  } catch {
    licenseState.reason = '超过 3 天未登录，请重新登录';
  }
  return licenseSummary();
}

async function licenseGate() {
  if (!licenseConfig?.required) return licenseSummary();
  if (!sessionVerified && !adminBypass) await ensureSession();
  return licenseSummary();
}

async function activateLicense(key) {
  if (!licenseConfig?.serverUrl) throw new Error('未配置授权服务器');
  const response = await fetch(`${licenseConfig.serverUrl.replace(/\/$/, '')}/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: String(key || '').trim(), device: deviceId }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.reason || '激活失败');
  if (!verifyLicenseToken(data.token)) throw new Error('许可证签名无效');
  licenseState = { token: data.token, key: String(key).trim(), lastCheck: Date.now(), lastLogin: Date.now(), maintenance: false, revoked: false, reason: '' };
  await saveLicenseState();
  sessionVerified = true;
  licenseCache = { at: Date.now(), summary: licenseSummary() };
  openControlStream();
  return licenseSummary();
}

async function autoActivateLicense() {
  if (!licenseConfig?.serverUrl) throw new Error('未配置授权服务器');
  const response = await fetch(`${licenseConfig.serverUrl.replace(/\/$/, '')}/auto-issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: account?.username || '', device: deviceId, product: 'nalo-code' }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.reason || '自动发码失败');
  if (!verifyLicenseToken(data.token)) throw new Error('许可证签名无效');
  licenseState = { token: data.token, key: data.key || '', lastCheck: Date.now(), lastLogin: Date.now(), maintenance: false, revoked: false, reason: '' };
  await saveLicenseState();
  licenseCache = { at: Date.now(), summary: licenseSummary() };
  return licenseSummary();
}



/* ------------------------------------------------------- account + usage */

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

const captchas = new Map();

function createCaptcha() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i += 1) code += alphabet[crypto.randomInt(alphabet.length)];
  const id = crypto.randomUUID();
  captchas.set(id, { code, exp: Date.now() + 5 * 60e3 });
  if (captchas.size > 2000) {
    for (const [key, value] of captchas) if (value.exp < Date.now()) captchas.delete(key);
  }
  const rand = (min, max) => min + Math.random() * (max - min);
  const chars = code.split('').map((ch, index) => {
    const x = 18 + index * 26;
    const y = 28 + rand(-2, 3);
    const rotate = rand(-16, 16);
    return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})" font-family="Segoe UI, Arial" font-size="24" font-weight="600" fill="#3a3b42">${ch}</text>`;
  }).join('');
  const lines = Array.from({ length: 5 }, () => {
    const x1 = rand(2, 118), y1 = rand(2, 40), x2 = rand(2, 118), y2 = rand(2, 40);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#b9bac2" stroke-width="1"/>`;
  }).join('');
  const dots = Array.from({ length: 28 }, () => `<circle cx="${rand(2, 118)}" cy="${rand(2, 40)}" r="1" fill="#c9cad1"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="42"><rect width="120" height="42" rx="8" fill="#f4f4f6"/>${dots}${lines}${chars}</svg>`;
  return { id, image: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
}


const emailCodes = new Map();
const passwordResets = new Map();
const emailRate = new Map();
const EMAIL_WEBHOOK_URL = process.env.EMAIL_WEBHOOK_URL || '';
const EMAIL_DEV_CODE = process.env.EMAIL_DEV_CODE !== 'false';
const EMAIL_RATE_MS = Number(process.env.EMAIL_RATE_SECONDS ?? 60) * 1000;
const EMAIL_API_URL = process.env.EMAIL_API_URL || 'https://api.nalo.work';


function smtpEncode(value) {
  return `=?UTF-8?B?${Buffer.from(String(value), 'utf8').toString('base64')}?=`;
}

async function sendSmtpMail({ host, port, user, pass, from, name, to, subject, text }) {
  const socket = tls.connect({ host, port: Number(port) || 465, servername: host, rejectUnauthorized: true });
  let buffer = '';
  let waiter = null;
  const pump = () => {
    const match = buffer.match(/^(\d{3})[ -]([^\n]*)\n/m);
    if (!match) return;
    if (buffer.slice(match.index).split('\n')[0].startsWith(`${match[1]}-`)) {
      // multiline: wait for the final "250 " line
      const final = buffer.match(new RegExp(`^${match[1]} [^\\n]*\\n`, 'm'));
      if (!final) return;
      const end = buffer.indexOf('\n', final.index) + 1;
      const response = buffer.slice(0, end);
      buffer = buffer.slice(end);
      if (waiter) { const resolve = waiter; waiter = null; resolve(response); }
      return;
    }
    const end = buffer.indexOf('\n') + 1;
    const response = buffer.slice(0, end);
    buffer = buffer.slice(end);
    if (waiter) { const resolve = waiter; waiter = null; resolve(response); }
  };
  socket.on('data', (chunk) => { buffer += chunk.toString('utf8'); pump(); });
  const read = () => new Promise((resolve, reject) => {
    waiter = resolve;
    socket.once('error', reject);
    setTimeout(() => { if (waiter) { waiter = null; reject(new Error('SMTP 超时')); } }, 20000);
    pump();
  });
  const write = (line) => new Promise((resolve) => socket.write(line + '\r\n', resolve));
  const expect = async (code, label) => {
    const response = await read();
    if (!response.startsWith(code)) throw new Error(`SMTP ${label} 失败：${response.trim().slice(0, 200)}`);
    return response;
  };
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
    setTimeout(() => reject(new Error('SMTP 连接超时')), 20000);
  });
  await expect('220', '连接');
  await write(`EHLO ${host}`); await expect('250', 'EHLO');
  await write('AUTH LOGIN'); await expect('334', 'AUTH');
  await write(Buffer.from(user, 'utf8').toString('base64')); await expect('334', '用户名');
  await write(Buffer.from(pass, 'utf8').toString('base64')); await expect('235', '密码');
  const sender = from || user;
  await write(`MAIL FROM:<${sender}>`); await expect('250', 'MAIL FROM');
  await write(`RCPT TO:<${to}>`); await expect('250', 'RCPT TO');
  await write('DATA'); await expect('354', 'DATA');
  const body = [
    `From: ${name ? smtpEncode(name) + ' ' : ''}<${sender}>`,
    `To: <${to}>`,
    `Subject: ${smtpEncode(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
  ].join('\r\n');
  for (const line of body.split('\r\n')) await write(line.startsWith('.') ? `.${line}` : line);
  await write('.'); await expect('250', '发送');
  await write('QUIT').catch(() => {});
  socket.end();
  return true;
}

function isBanned(user) {
  if (!user) return false;
  if (user.banPermanent) return true;
  return Number(user.bannedUntil || 0) > Date.now();
}

function banMessage(user) {
  if (user.banPermanent) return '因违反淬序工坊的使用规范，您的账号已被封禁，结束时间：永久封禁';
  const d = new Date(Number(user.bannedUntil));
  const text = `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`;
  return `因违反淬序工坊的使用规范，您的账号已被封禁，结束时间：${text}`;
}

async function sendEmailCode(email) {
  const now = Date.now();
  const last = emailRate.get(email) || 0;
  if (now - last < EMAIL_RATE_MS) throw new Error('发送太频繁，请稍后再试');
  emailRate.set(email, now);
  const code = String(crypto.randomInt(100000, 999999));
  emailCodes.set(email, { code, exp: now + 10 * 60e3, tries: 0 });
  if (EMAIL_API_URL) {
    try {
      const response = await fetch(`${EMAIL_API_URL.replace(/\/$/, '')}/email/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code })
      });
      if (response.ok) return { sent: true };
    } catch { /* fall through to local delivery */ }
  }

  if (config.smtp?.host && config.smtp?.user && config.smtp?.pass) {
        await sendSmtpMail({
          host: config.smtp.host,
          port: config.smtp.port || 465,
          user: config.smtp.user,
          pass: config.smtp.pass,
          from: config.smtp.from || config.smtp.user,
          name: config.smtp.name || 'Nalo Code',
          to: email,
          subject: 'Nalo Code 登录验证码',
          text: `你的验证码是 ${code}，10 分钟内有效。`
        });
        return { sent: true };
      }
      if (EMAIL_WEBHOOK_URL) {
    const response = await fetch(EMAIL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: email, subject: 'Nalo Code 登录验证码', text: `你的验证码是 ${code}，10 分钟内有效。`, code })
    });
    if (!response.ok) throw new Error('邮件发送失败，请稍后再试');
    return { sent: true };
  }
  if (!EMAIL_DEV_CODE) throw new Error('未配置邮件服务');
  console.log(`[email] ${email} -> ${code}`);
  return { sent: true, devCode: code };
}

function verifyEmailCode(email, code) {
  const record = emailCodes.get(email);
  if (!record || record.exp < Date.now()) return false;
  record.tries += 1;
  if (record.tries > 5) { emailCodes.delete(email); return false; }
  if (String(code || '').trim() !== record.code) return false;
  emailCodes.delete(email);
  return true;
}

function verifyCaptcha(id, answer) {
  const record = captchas.get(String(id || ''));
  if (!record || record.exp < Date.now()) return false;
  captchas.delete(id);
  return String(answer || '').trim().toUpperCase() === record.code;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const jar = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

function currentUsername(req) {
  const token = parseCookies(req).flow_auth;
  if (!token) return null;
  let record = authTokens.get(token);
  if (!record) return null;
  if (typeof record === 'number') record = { exp: record, username: account?.username || '' };
  if (!record.exp || record.exp < Date.now() || !record.username) { authTokens.delete(token); return null; }
  authTokens.set(token, record);
  const username = record.username;
  if (account?.username !== username) {
    const user = users.find((item) => item.username === username);
    if (user) {
      account = user;
      applyProfile(username);
      applyUserConfig(username);
      applyUserUsage(username);
    }
  }
  return username;
}

function canAccessSession(req, session) {
  if (!session) return false;
  const username = currentUsername(req);
  if (!username) return false;
  if (!session.owner) { session.owner = username; saveSessionsSoon(); return true; }
  return session.owner === username;
}

function grantAuth(res, remember) {
  const token = crypto.randomUUID();
  authTokens.set(token, { exp: Date.now() + (remember ? 30 : 7) * 24 * 3600 * 1000, username: account?.username || '' });
  saveAuthTokens();
  res.setHeader('set-cookie',
    `flow_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${remember ? 2592000 : 604800}`);
}

async function saveUsers() {
  try { await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8'); } catch { }
}

async function loadUsers() {
  try {
    users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    if (!Array.isArray(users)) users = [];
  } catch { users = []; }
  if (account && !users.some((item) => item.username === account.username)) {
    users.push({ ...account, id: crypto.randomUUID(), plan: config.plan || 'free', createdAt: account.createdAt || Date.now() });
    await saveUsers();
  }
}

function publicProfile() {
  const email = account?.email || '';
  return {
    username: account?.username || '',
    email,
    role: account?.role || 'user',
    plan: account?.plan || config.plan || 'free',
    role: account?.role || 'user',
    maintenance: maintenanceState,
    nickname: profile.nickname || '',
    birthDate: profile.birthDate || '',
    gender: profile.gender || 'private',
    avatar: profile.avatar || '',
    age: ageFromBirth(profile.birthDate)
  };
}

function ageFromBirth(value) {
  if (!value) return null;
  const birth = new Date(value.length <= 7 ? `${value}-01` : value);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const beforeBirthday = now.getMonth() < birth.getMonth()
    || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

let usageTimer = null;
function recordUsage(promptTokens, completionTokens) {
  if (!promptTokens && !completionTokens) return;
  usage.promptTokens += promptTokens || 0;
  usage.completionTokens += completionTokens || 0;
  usage.updatedAt = Date.now();
  const day = new Date().toISOString().slice(0, 10);
  const bucket = usage.days[day] || { prompt: 0, completion: 0 };
  bucket.prompt += promptTokens || 0;
  bucket.completion += completionTokens || 0;
  usage.days[day] = bucket;
  clearTimeout(usageTimer);
  const owner = account?.username || '';
  const isAdmin = account?.role === 'admin';
  const snapshot = JSON.parse(JSON.stringify(usage));
  usageTimer = setTimeout(() => {
    if (owner) userUsages[owner] = snapshot;
    saveUserUsages();
    if (isAdmin) fs.writeFile(USAGE_FILE, JSON.stringify(snapshot, null, 2), 'utf8').catch(() => {});
  }, 200);
}

function applyUserUsage(username) {
  const empty = { promptTokens: 0, completionTokens: 0, updatedAt: 0, days: {} };
  usage = { ...empty, ...(userUsages[username] || {}) };
  if (!usage.days || typeof usage.days !== 'object') usage.days = {};
}

async function saveUserUsages() {
  try {
    await fs.writeFile(USAGES_FILE, JSON.stringify(userUsages, null, 2), 'utf8');
    await fs.chmod(USAGES_FILE, 0o600);
  } catch { }
}

function defaultProfile(username) {
  return { nickname: username || '', birthDate: '', gender: 'private', avatar: '', updatedAt: 0 };
}

function applyProfile(username) {
  profile = { ...defaultProfile(username), ...(profiles[username] || {}), nickname: (profiles[username]?.nickname || username || '') };
}

async function saveProfile() {
  profile.updatedAt = Date.now();
  if (account?.username) profiles[account.username] = { ...profile };
  await fs.writeFile(PROFILE_FILE, JSON.stringify(profile, null, 2), 'utf8');
  try { await fs.writeFile(PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf8'); } catch { }
}

async function saveAccount() {
  await fs.writeFile(ACCOUNT_FILE, JSON.stringify(account, null, 2), 'utf8');
}

function applyUserConfig(username) {
  config = { ...DEFAULT_CONFIG, ...(userConfigs[username] || {}) };
  if (!Number(config.maxTokens) || Number(config.maxTokens) < 1000000) config.maxTokens = 1000000;
}

async function saveUserConfigs() {
  try {
    await fs.writeFile(CONFIGS_FILE, JSON.stringify(userConfigs, null, 2), 'utf8');
    await fs.chmod(CONFIGS_FILE, 0o600);
  } catch { }
}

async function saveConfig() {
  await fs.mkdir(DATA, { recursive: true });
  if (account?.username) userConfigs[account.username] = { ...config };
  await saveUserConfigs();
  if (account?.role === 'admin') {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    try { await fs.chmod(CONFIG_FILE, 0o600); } catch { /* windows */ }
  }
}

let sessionTimer = null;
async function ensureSessionWorkspace(session) {
  if (!session) return config.workspace;
  if (!session.workspace) session.workspace = path.join(config.workspace, 'sessions', session.id);
  await fs.mkdir(session.workspace, { recursive: true });
  return session.workspace;
}

function saveDeletedNow() {
  try { fsSync.writeFileSync(DELETED_FILE, JSON.stringify(deletedState), 'utf8'); } catch (e) {  }
}

function saveSessionsNow() {
  try {
        sessions = sessions.filter((item) => item.automationId || (!deletedState.ids.includes(item.id) && (item.updatedAt || 0) > deletedState.allAt));
    fsSync.mkdirSync(DATA, { recursive: true });
    fsSync.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (e) {  }
}

function saveSessionsSoon() {
  clearTimeout(sessionTimer);
  saveSessionsNow();
}

process.on('exit', saveSessionsNow);
process.on('SIGINT', () => { saveSessionsNow(); process.exit(0); });
process.on('SIGTERM', () => { saveSessionsNow(); process.exit(0); });

/* ------------------------------------------------------------------ utils */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}••••${key.slice(-3)}`;
}

let localProbe = { at: 0, ok: false };

async function probeLocalModel(force = false) {
  if (!force && Date.now() - localProbe.at < 8000) return localProbe.ok;
  try {
    const response = await fetch(`${LOCAL_MODEL_URL}/models`, { signal: AbortSignal.timeout(1500) });
    localProbe = { at: Date.now(), ok: response.ok };
  } catch {
    localProbe = { at: Date.now(), ok: false };
  }
  return localProbe.ok;
}

function useLocalModel() {
  return Boolean(config.localModelEnabled) && probeLocalModel();
}

let memoryNotes = [];
try {
  memoryNotes = JSON.parse(await fs.readFile(path.join(DATA, 'memory.json'), 'utf8'));
  if (!Array.isArray(memoryNotes)) memoryNotes = [];
} catch { memoryNotes = []; }

async function saveMemory() {
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(path.join(DATA, 'memory.json'), JSON.stringify(memoryNotes, null, 2), 'utf8');
}

function publicConfig() {
  return {
    baseUrl: config.baseUrl,
    plan: config.plan || 'free',
    planLimits: PLANS[config.plan || 'free'] || PLANS.free,
    protocol: config.protocol || 'openai',
    thinkingLevel: config.thinkingLevel || 'medium',
    model: config.model,
    hasKey: Boolean(config.apiKey),
    keyHint: maskKey(config.apiKey),
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    systemPrompt: config.systemPrompt,
    workspace: config.workspace,
    models: Array.isArray(config.models) ? config.models : [],
    searchEnabled: Boolean(config.searchEnabled),
    thinkingLimit: Number(config.thinkingLimit) || 0,
    permission: config.permission || 'confirm',
    agentDispatch: true,
    localModelEnabled: Boolean(config.localModelEnabled),
    disabledTools: Array.isArray(config.disabledTools) ? config.disabledTools : [],
    vision: { baseUrl: config.vision?.baseUrl || '', model: config.vision?.model || '', configured: Boolean(config.vision?.baseUrl && config.vision?.model) },
    transcribe: { baseUrl: config.transcribe?.baseUrl || '', model: config.transcribe?.model || '', configured: Boolean(config.transcribe?.baseUrl && config.transcribe?.model) },
    browsers: { chrome: config.browsers?.chrome !== false, edge: config.browsers?.edge !== false },
    providers: (Array.isArray(config.providers) ? config.providers : []).map((item) => ({
      id: item.id, name: item.name, model: item.model, baseUrl: item.baseUrl
    })),
    activeProviderId: config.activeProviderId || '',
    contextMessages: Number(config.contextMessages) || 0,
    compressAfterTokens: Number(config.compressAfterTokens) || 100000000,
    configured: Boolean(config.baseUrl && config.apiKey && config.model)
  };
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function providerEndpoint(base, suffix) {
  const trimmed = String(base || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('未配置 Base URL');
  return `${trimmed}${suffix}`;
}

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Base URL 格式不正确，需要 http(s) 地址'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Base URL 只支持 http 或 https');
  return url.toString().replace(/\/+$/, '');
}

function resolveTarget(target, workspace = config.workspace) {
  const raw = String(target || '');
  if (path.isAbsolute(raw)) {
    if (config.permission === 'forbidden') throw new Error('当前访问权限为禁止访问，无法读取工作区以外的路径');
    return path.resolve(raw);
  }
  return resolveInside(workspace, raw);
}

function resolveInside(workspace, relative) {
  const cleaned = String(relative || '.').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(workspace, cleaned || '.');
  const rootResolved = path.resolve(workspace);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new Error('路径越出工作区');
  }
  return target;
}

function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  };
}

/* -------------------------------------------------------------- provider */

async function listProviderModels({ baseUrl, apiKey }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(providerEndpoint(baseUrl, '/models'), {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`模型列表请求失败：HTTP ${response.status} ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed?.data) ? parsed.data
      : Array.isArray(parsed?.models) ? parsed.models : [];
    return list.map((item) => (typeof item === 'string' ? item : item?.id || item?.name))
      .filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}


function syntheticSse(text, usage = {}) {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }], usage })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n'
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function providerStreamAnthropic({ messages, signal }) {
  const base = String(config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const endpoint = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const chat = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content || '') }));
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify((() => {
      const level = config.thinkingLevel || 'medium';
      const budget = thinkingBudget(level, config.maxTokens);
      const body = { model: config.model, max_tokens: Math.max(config.maxTokens || 4096, budget + 1024), system, messages: chat };
      if (level !== 'unlimited' || budget > 1024) {
        body.thinking = { type: 'enabled', budget_tokens: budget };
        body.temperature = 1;
      } else {
        body.temperature = config.temperature;
      }
      return body;
    })()),
    signal
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Claude 请求失败：HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`);
  const text = (data.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
  return syntheticSse(text, { prompt_tokens: data.usage?.input_tokens || 0, completion_tokens: data.usage?.output_tokens || 0 });
}

async function providerStreamGemini({ messages, signal }) {
  const base = String(config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const endpoint = `${base}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const contents = messages.filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] }));
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify((() => {
      const level = config.thinkingLevel || 'medium';
      const generationConfig = { temperature: config.temperature, maxOutputTokens: config.maxTokens || 4096 };
      if (String(config.model).includes('gemini-3')) {
        generationConfig.thinkingConfig = { thinkingLevel: level === 'low' ? 'low' : 'high' };
      } else {
        generationConfig.thinkingConfig = { thinkingBudget: level === 'unlimited' ? -1 : thinkingBudget(level, config.maxTokens) };
      }
      return { contents, systemInstruction: system ? { parts: [{ text: system }] } : undefined, generationConfig };
    })()),
    signal
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gemini 请求失败：HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`);
  const text = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('');
  return syntheticSse(text, { prompt_tokens: data.usageMetadata?.promptTokenCount || 0, completion_tokens: data.usageMetadata?.candidatesTokenCount || 0 });
}

const THINKING_BUDGETS = { low: 1024, medium: 4096, high: 16384, unlimited: 0 };

function thinkingBudget(level, maxTokens) {
  if (level === 'unlimited') return Math.max(1024, Number(maxTokens) - 1024);
  return THINKING_BUDGETS[level] || THINKING_BUDGETS.medium;
}

async function providerStream({ messages, tools, signal }) {
  const local = config.localModelEnabled;
  const body = {
    model: local ? LOCAL_MODEL_NAME : config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (tools) { body.tools = tools; if (!local) body.tool_choice = 'auto'; }
  if (config.thinkingLevel && config.thinkingLevel !== 'unlimited') body.reasoning_effort = config.thinkingLevel;
  if (Number(config.thinkingLimit) > 0) body.max_thinking_tokens = Number(config.thinkingLimit);

  if (local) {
    const localBody = { ...body };
    delete localBody.stream_options;
    const callLocal = () => fetch(`${LOCAL_MODEL_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(localBody),
      signal
    });
    let response = await callLocal();
    if (!response.ok && response.status === 400 && localBody.tools) {
      const detail = await response.clone().text().catch(() => '');
      console.log('[local tools rejected]', response.status, detail.slice(0, 300));
      delete localBody.tools;
      response = await callLocal();
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`本地模型请求失败：HTTP ${response.status} ${detail.slice(0, 300)}`);
    }
    return response;
  }

async function fetchModel(url, options, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  const reason = lastError?.cause?.code || lastError?.message || '网络不可达';
  throw new Error(`模型连接失败：${reason}。请检查 Base URL、网络或代理设置。`);
}

  if (config.protocol === 'anthropic') return providerStreamAnthropic({ messages, signal });
  if (config.protocol === 'gemini') return providerStreamGemini({ messages, signal });

  let response = await fetchModel(providerEndpoint(config.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream'
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok && response.status === 400) {
    const detail = await response.clone().text().catch(() => '');
    const match = detail.match(/max_tokens is \[1,\s*(\d+)\]/i) || detail.match(/max_tokens[^\d]*(\d{4,})/i);
    if (/max_tokens|maximum.*tokens|valid range/i.test(detail) && match) {
      const cap = Number(match[1]);
      if (cap > 0 && cap < Number(body.max_tokens)) {
        body.max_tokens = cap;
        response = await fetchModel(providerEndpoint(config.baseUrl, '/chat/completions'), {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal
        });
      }
    }
  }

  // Some gateways reject tool definitions; retry plainly instead of failing the turn.
  if (!response.ok && tools && [400, 404, 422].includes(response.status)) {
    const detail = await response.text();
    if (/tool|function/i.test(detail)) {
      delete body.tools;
      response = await fetchModel(providerEndpoint(config.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        body: JSON.stringify(body),
        signal
      });
    } else {
      throw new Error(`模型请求失败：HTTP ${response.status} ${detail.slice(0, 400)}`);
    }
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`模型请求失败：HTTP ${response.status} ${detail.slice(0, 400)}`);
  }

  return response;
}

async function* parseSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try { yield JSON.parse(payload); } catch { /* keep-alive noise */ }
      }
    }
    if (buffer.trim().startsWith('data:')) {
      const payload = buffer.trim().slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try { yield JSON.parse(payload); } catch { /* ignore */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/* ----------------------------------------------------------------- tools */

function runProcess(command, args, { timeout = 90000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error('处理超时'));
    }, timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      const error = new Error(stderr.trim() || `命令退出码 ${code}`);
      error.code = code;
      return reject(error);
    });
  });
}

async function runTool(name, args, workspace = config.workspace) {
  switch (name) {
    case 'list_files': {
      const target = resolveTarget(args?.path || '.');
      const entries = await fs.readdir(target, { withFileTypes: true });
      const rows = [];
      for (const entry of entries.slice(0, 400)) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(target, entry.name);
        let size = 0;
        if (entry.isFile()) {
          try { size = (await fs.stat(full)).size; } catch { /* ignore */ }
        }
        rows.push(`${entry.isDirectory() ? 'DIR ' : 'FILE'} ${entry.name}${entry.isFile() ? ` (${size} B)` : ''}`);
      }
      return rows.length ? rows.join('\n') : '（空目录）';
    }
    case 'read_file': {
      const target = resolveTarget(args?.path, workspace);
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error('不是文件');
      if (stat.size > MAX_FILE_BYTES) throw new Error(`文件超过 ${MAX_FILE_BYTES / 1024} KB`);
      const text = await fs.readFile(target, 'utf8');
      return text.split('\n').map((line, index) => `${String(index + 1).padStart(4, ' ')} | ${line}`).join('\n');
    }
    case 'write_file': {
      const target = resolveTarget(args?.path, workspace);
      const content = String(args?.content ?? '');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      const relative = path.relative(path.resolve(workspace), target).replace(/\\/g, '/');
      const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      return { text: `已写入 ${inside ? relative : target}（${Buffer.byteLength(content)} 字节）`, file: inside ? relative : undefined };
    }
    case 'read_image': {
      const target = resolveTarget(args?.path, workspace);
      await fs.access(target);
      try {
        const text = await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS_DIR, 'ocr.ps1'), '-Path', target]);
        return `图片文字识别结果：\n${text}`;
      } catch (error) {
        if (error.code === 2) return '图片里没有识别到文字（可能是纯图形或照片）。';
        throw error;
      }
    }
    case 'preview_file': {
      const target = resolveTarget(args?.path, workspace);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) throw new Error('文件不存在');
      const token = crypto.randomUUID();
      previews.set(token, { path: target, exp: Date.now() + 3600e3 });
      const url = `http://127.0.0.1:${PORT}/preview/${token}`;
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      const relative = path.relative(path.resolve(workspace), target).replace(/\\/g, '/');
      return { text: `已打开预览：${url}\n文件：${relative}`, file: relative, url };
    }
    case 'read_document': {
      const target = resolveTarget(args?.path, workspace);
      await fs.access(target);
      if (path.extname(target).toLowerCase() === '.pdf') {
        const textLayer = await runProcess(PYTHON_BIN, [path.join(TOOLS_DIR, 'pdf_tools.py'), 'read', target], { timeout: 120000 }).catch(() => '');
        if (textLayer && !textLayer.includes('（这一页没有文字层）') && textLayer.replace(/\s/g, '').length > 40) {
          return textLayer;
        }
        const dir = path.join(os.tmpdir(), `nalo-pdf-${crypto.randomUUID()}`);
        await fs.mkdir(dir, { recursive: true });
        try {
          const output = await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS_DIR, 'pdf_render.ps1'), '-Path', target, '-OutDir', dir, '-MaxPages', '3'], { timeout: 120000 });
          const pages = output.split(/\r?\n/).filter(Boolean);
          const texts = [];
          for (const pageFile of pages) {
            let pageText = '';
            try {
              pageText = await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS_DIR, 'ocr.ps1'), '-Path', pageFile], { timeout: 60000 });
            } catch (error) {
              pageText = error.code === 2 ? '（本页没有识别到文字）' : `（识别失败：${error.message}）`;
            }
            texts.push(`第 ${texts.length + 1} 页：\n${pageText}`);
          }
          return texts.length ? texts.join('\n\n') : 'PDF 没有可读取的页面';
        } finally {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
      const text = await runProcess(PYTHON_BIN, [path.join(TOOLS_DIR, 'doc_tools.py'), 'read', target]);
      return text.length > 15000 ? `${text.slice(0, 15000)}\n…（已截断）` : text;
    }
    case 'create_document': {
      const target = resolveTarget(args?.path, workspace);
      if (!args?.path) throw new Error('缺少输出路径');
      await fs.mkdir(path.dirname(target), { recursive: true });
      const suffix = path.extname(target).toLowerCase();
      const relative = path.relative(path.resolve(workspace), target).replace(/\\/g, '/');
      if (suffix === '.wps' || suffix === '.doc') {
        const spec = path.join(os.tmpdir(), `nalo-wps-${crypto.randomUUID()}.json`);
        await fs.writeFile(spec, JSON.stringify({ ...args, path: target }, null, 2), 'utf8');
        try {
          await runProcess('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS_DIR, 'wps_create.ps1'), '-Spec', spec], { timeout: 120000 });
        } finally {
          await fs.unlink(spec).catch(() => {});
        }
        return { text: `已创建 WPS 文档：${relative}`, file: relative };
      }
      const spec = path.join(os.tmpdir(), `nalo-doc-${crypto.randomUUID()}.json`);
      await fs.writeFile(spec, JSON.stringify({ ...args, path: target }, null, 2), 'utf8');
      try {
        const text = await runProcess(PYTHON_BIN, [path.join(TOOLS_DIR, 'doc_tools.py'), 'create', spec], { timeout: 120000 });
        return { text, file: relative };
      } finally {
        await fs.unlink(spec).catch(() => {});
      }
    }
    case 'edit_pdf': {
      const src = resolveTarget(args?.path, workspace);
      await fs.access(src);
      const edits = Array.isArray(args?.edits) ? args.edits : [];
      if (!edits.length) throw new Error('缺少要修改的内容');
      const target = args?.target
        ? resolveTarget(args.target, workspace)
        : src.replace(/\.pdf$/i, '-edited.pdf');
      await fs.mkdir(path.dirname(target), { recursive: true });
      const opsFile = path.join(os.tmpdir(), `nalo-pdfops-${crypto.randomUUID()}.json`);
      await fs.writeFile(opsFile, JSON.stringify(edits), 'utf8');
      try {
        const text = await runProcess(PYTHON_BIN, [path.join(TOOLS_DIR, 'pdf_tools.py'), 'replace', src, target, opsFile], { timeout: 180000 });
        const relative = path.relative(path.resolve(workspace), target).replace(/\\\\/g, '/');
        const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
        return { text, file: inside ? relative : undefined };
      } finally {
        await fs.unlink(opsFile).catch(() => {});
      }
    }
    case 'convert_image': {
      const src = resolveTarget(args?.path, workspace);
      const dst = resolveTarget(args?.target, workspace);
      await fs.access(src);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      const extra = [];
      if (args?.width) extra.push('--width', String(args.width));
      if (args?.quality) extra.push('--quality', String(args.quality));
      const text = await runProcess(PYTHON_BIN, [path.join(TOOLS_DIR, 'doc_tools.py'), 'convert', src, dst, ...extra]);
      const relative = path.relative(path.resolve(workspace), dst).replace(/\\/g, '/');
      return { text, file: relative };
    }
    case 'generate_image': {
      const prompt = String(args?.prompt || '').trim();
      if (!prompt) throw new Error('图片描述不能为空');
      const dir = path.join(workspace, 'images');
      await fs.mkdir(dir, { recursive: true });
      const safe = String(args?.filename || `image-${Date.now()}.png`).replace(/[^\w.\-]/g, '_');
      const name = safe.toLowerCase().endsWith('.png') ? safe : `${safe}.png`;
      const dst = path.join(dir, name);
      const relative = path.relative(path.resolve(workspace), dst).replace(/\\/g, '/');
      let buffer = null;
      let remoteError = '';
      const noImageApi = /deepseek/i.test(String(config.baseUrl || '')) || /deepseek/i.test(String(config.model || ''));
      if (config.baseUrl && config.apiKey && !noImageApi) {
        try {
          const endpoint = providerEndpoint(config.baseUrl, '/images/generations');
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: config.imageModel || 'gpt-image-1', prompt, size: args?.size || '1024x1024', n: 1, response_format: 'b64_json' })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const item = data?.data?.[0] || {};
          if (item.b64_json) buffer = Buffer.from(item.b64_json, 'base64');
          else if (item.url) {
            const image = await fetch(item.url);
            if (!image.ok) throw new Error('图片下载失败');
            buffer = Buffer.from(await image.arrayBuffer());
          } else throw new Error('接口没有返回图片');
        } catch (error) {
          remoteError = error.message;
          buffer = null;
        }
      }
      if (!buffer) {
        try {
          let width = 1024;
          let height = 1024;
          const sizeText = String(args?.size || '');
          const match = sizeText.match(/^(\d+)x(\d+)$/);
          if (match) { width = Number(match[1]); height = Number(match[2]); }
          else if (/16:9|横版|宽屏/.test(prompt)) { width = 1280; height = 720; }
          else if (/9:16|竖版|海报/.test(prompt)) { width = 864; height = 1152; }
          const seed = Math.floor(Math.random() * 900000) + 1000;
          const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt + ', high quality, cinematic, no text, no watermark')}?width=${width}&height=${height}&nologo=true&seed=${seed}`;
          const imageResponse = await fetch(url, { signal: AbortSignal.timeout(90000) });
          if (imageResponse.ok) {
            const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
            if (imageBuffer.length > 10000 && /^image\//i.test(imageResponse.headers.get('content-type') || 'image/jpeg')) buffer = imageBuffer;
          } else remoteError = remoteError || `HTTP ${imageResponse.status}`;
        } catch (error) { remoteError = remoteError || error.message; }
      }
      if (buffer) {
        await fs.writeFile(dst, buffer);
        return { text: `已生成图片：${relative}`, file: relative };
      }
      const text = await runProcess(PYTHON_BIN, [path.join(TOOLS_DIR, 'local_image.py'), prompt, dst], { timeout: 120000 });
      const note = remoteError ? `（AI 绘图不可用：${remoteError}，已使用本地备用绘图）` : '（本地备用绘图）';
      return { text: `已生成图片${note}：${relative}`, file: relative };
    }
    case 'edit_document': {
      const target = resolveTarget(args?.path, workspace);
      await fs.access(target);
      if (!Array.isArray(args?.edits) || !args.edits.length) throw new Error('edits 不能为空');
      const tmp = path.join(os.tmpdir(), `nalo-edits-${crypto.randomUUID()}.json`);
      await fs.writeFile(tmp, JSON.stringify(args.edits), 'utf8');
      try {
        const text = await runProcess(PYTHON_BIN, [path.join(TOOLS_DIR, 'doc_tools.py'), 'edit', target, tmp]);
        const relative = path.relative(path.resolve(workspace), target).replace(/\\/g, '/');
        return { text, file: relative };
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    }
    case name.startsWith('mcp__') ? name : '__mcp': {
      const [, serverName, ...rest] = name.split('__');
      const toolName = rest.join('__');
      const client = mcpClients.get(serverName);
      if (!client || client.status !== 'connected') throw new Error(`MCP 服务 ${serverName} 未连接`);
      return await client.callTool(toolName, args || {});
    }
    case 'list_drives': {
      const drives = [];
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const root = `${letter}:\\`;
        try {
          const stat = await fs.stat(root);
          if (stat.isDirectory()) drives.push(root);
        } catch { /* not present */ }
      }
      return drives.length ? `磁盘分区：\n${drives.join('\n')}` : '没有找到磁盘分区';
    }
    case 'open_url': {
      const url = String(args?.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https 网址');
      let browser = String(args?.browser || '').toLowerCase();
      const allowed = { chrome: config.browsers?.chrome !== false, edge: config.browsers?.edge !== false };
      if (!browser || browser === 'default') browser = allowed.chrome ? 'chrome' : (allowed.edge ? 'edge' : 'default');
      if (browser === 'msedge') browser = 'edge';
      if (browser !== 'default' && allowed[browser] === false) throw new Error(`你已在插件里关闭 ${browser} 浏览器`);
      const map = { chrome: 'chrome', edge: 'msedge', default: '' };
      const exe = map[browser] ?? '';
      spawn('cmd.exe', ['/c', 'start', '', ...(exe ? [exe] : []), url], {
        detached: true, stdio: 'ignore', windowsHide: true
      }).unref();
      return `已在${browser || '默认'}浏览器打开 ${url}`;
    }
    case 'look_screen': {
      const shot = path.join(os.tmpdir(), `nalo-screen-${crypto.randomUUID()}.png`);
      try {
        await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS_DIR, 'screen.ps1'), '-Out', shot], { timeout: 30000 });
        const text = await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS_DIR, 'ocr.ps1'), '-Path', shot], { timeout: 60000 });
        return `屏幕文字识别结果：\n${text}`;
      } finally {
        await fs.unlink(shot).catch(() => {});
      }
    }
    case 'run_command': {
      const command = String(args?.command || '').trim();
      if (!command) throw new Error('命令不能为空');
      const timeout = Math.min(180000, Number(args?.timeout) || 120000);
      const output = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout, cwd: workspace });
      return output ? output.slice(0, 12000) : '（命令执行完成，没有输出）';
    }
    case 'search_files': {
      const query = String(args?.query || '');
      if (!query) throw new Error('缺少搜索内容');
      const root = resolveTarget(args?.path || '.', workspace);
      const limit = Math.min(200, Number(args?.limit) || 60);
      let matcher;
      try { matcher = new RegExp(query, 'i'); } catch { matcher = null; }
      const hits = [];
      const walk = async (dir, depth) => {
        if (depth > 7 || hits.length >= limit) return;
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (hits.length >= limit) return;
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
          const stat = await fs.stat(full).catch(() => null);
          if (!stat || stat.size > 512 * 1024) continue;
          let text;
          try { text = await fs.readFile(full, 'utf8'); } catch { continue; }
          if (text.includes('\u0000')) continue;
          text.split('\n').forEach((line, index) => {
            if (hits.length >= limit) return;
            const ok = matcher ? matcher.test(line) : line.includes(query);
            if (ok) hits.push(`${path.relative(path.resolve(workspace), full).replace(/\\/g, '/')}:${index + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
      };
      await walk(root, 0);
      return hits.length ? hits.join('\n') : '没有找到匹配内容';
    }
    case 'glob_files': {
      const pattern = String(args?.pattern || '*');
      const results = [];
      if (typeof fs.glob === 'function') {
        try {
          for await (const entry of fs.glob(pattern, { cwd: workspace })) results.push(entry);
        } catch { /* fall through */ }
      }
      if (!results.length) {
        const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
        const walk = async (dir) => {
          const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            const rel = path.relative(path.resolve(workspace), full).replace(/\\/g, '/');
            if (entry.isDirectory()) await walk(full);
            else if (regex.test(rel)) results.push(rel);
          }
        };
        await walk(path.resolve(workspace));
      }
      return results.length ? results.slice(0, 300).join('\n') : '没有匹配的文件';
    }
    case 'edit_file': {
      const target = resolveTarget(args?.path, workspace);
      const find = String(args?.find ?? '');
      const replace = String(args?.replace ?? '');
      if (!find) throw new Error('缺少要查找的内容');
      const text = await fs.readFile(target, 'utf8');
      if (!text.includes(find)) throw new Error('文件里没有找到要替换的内容');
      const count = text.split(find).length - 1;
      const next = args?.all ? text.split(find).join(replace) : text.replace(find, replace);
      await fs.writeFile(target, next, 'utf8');
      const relative = path.relative(path.resolve(workspace), target).replace(/\\/g, '/');
      return { text: `已修改 ${relative}（替换 ${args?.all ? count : 1} 处）`, file: relative };
    }
    case 'remember': {
      const text = String(args?.text || '').trim();
      if (!text) throw new Error('缺少记忆内容');
      memoryNotes.push({ id: crypto.randomUUID(), text: text.slice(0, 500), createdAt: Date.now() });
      await saveMemory();
      return `已记住（共 ${memoryNotes.length} 条）`;
    }
    case 'recall': {
      const query = String(args?.query || '').toLowerCase();
      const list = query ? memoryNotes.filter((note) => note.text.toLowerCase().includes(query)) : memoryNotes;
      return list.length ? list.map((note) => `- ${note.text}`).join('\n') : '还没有长期记忆';
    }
    case 'run_code': {
      const language = String(args?.language || '').toLowerCase();
      return await runCode({ language, code: args?.code, file: args?.file, args: args?.args });
    }
    case 'list_runtimes': {
      const list = await runtimes();
      return list.map((item) => `${item.available ? '✓' : '×'} ${item.label}${item.available ? ` — ${item.version}` : item.install ? `（安装：${item.install}）` : ''}`).join('\n');
    }
    case 'edit_scanned_pdf': {
      const src = resolveTarget(args?.path, workspace);
      await fs.access(src);
      const edits = Array.isArray(args?.edits) ? args.edits : [];
      if (!edits.length) throw new Error('缺少要修改的内容');
      const dir = path.join(os.tmpdir(), `nalo-scan-${crypto.randomUUID()}`);
      await fs.mkdir(dir, { recursive: true });
      try {
        const rendered = await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS_DIR, 'pdf_render.ps1'), '-Path', src, '-OutDir', dir, '-MaxPages', '3'], { timeout: 180000 });
        const pages = rendered.split(/\r?\n/).filter(Boolean);
        const boxes = {};
        for (const pageFile of pages) {
          const jsonText = await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS_DIR, 'ocr_boxes.ps1'), '-Path', pageFile], { timeout: 90000 });
          try { boxes[path.basename(pageFile)] = JSON.parse(jsonText); } catch { boxes[path.basename(pageFile)] = { lines: [] }; }
        }
        const boxesFile = path.join(dir, 'boxes.json');
        const opsFile = path.join(dir, 'ops.json');
        await fs.writeFile(boxesFile, JSON.stringify(boxes), 'utf8');
        await fs.writeFile(opsFile, JSON.stringify(edits), 'utf8');
        const target = args?.target
          ? resolveTarget(args.target, workspace)
          : src.replace(/\.pdf$/i, '-scanned-edited.pdf');
        await fs.mkdir(path.dirname(target), { recursive: true });
        const text = await runProcess(PYTHON_BIN, [path.join(TOOLS_DIR, 'pdf_scanned_edit.py'), dir, boxesFile, opsFile, target], { timeout: 180000 });
        const relative = path.relative(path.resolve(workspace), target).replace(/\\/g, '/');
        return { text, file: relative.startsWith('..') ? undefined : relative };
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    case 'office_edit': {
      const target = resolveTarget(args?.path, workspace);
      await fs.access(target);
      const ops = Array.isArray(args?.ops) ? args.ops : [];
      if (!ops.length) throw new Error('缺少 ops');
      const spec = path.join(os.tmpdir(), `nalo-office-${crypto.randomUUID()}.json`);
      await fs.writeFile(spec, JSON.stringify({ path: target, ops }), 'utf8');
      try {
        const text = await runProcess(PYTHON_BIN, [path.join(TOOLS_DIR, 'doc_tools.py'), 'office_edit', spec], { timeout: 180000 });
        const relative = path.relative(path.resolve(workspace), target).replace(/\\\\/g, '/');
        return { text, file: relative.startsWith('..') ? undefined : relative };
      } finally {
        await fs.unlink(spec).catch(() => {});
      }
    }
    case 'verify_project': {
      const root = workspace;
      const entries = await fs.readdir(root).catch(() => []);
      const hasPackage = entries.includes('package.json');
      let command = '';
      if (hasPackage) {
        const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8').catch(() => '{}'));
        if (pkg.scripts?.test) command = 'npm test --silent';
      }
      if (!command) {
        const pyTest = entries.some((name) => ['pytest.ini', 'pyproject.toml', 'tox.ini'].includes(name)) || entries.includes('tests');
        if (pyTest) command = 'python -m pytest -q';
      }
      if (!command && entries.some((name) => name.endsWith('.test.js') || name.endsWith('.spec.js'))) command = 'node --test';
      if (!command) return '没有检测到测试配置（package.json 的 test 脚本 / pytest / node --test）';
      const output = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: root, timeout: 180000 });
      return `执行：${command}\\n\\n${output || '（没有输出）'}`;
    }
    case 'analyze_image': {
      const vision = config.vision || {};
      if (!vision.baseUrl || !vision.model) throw new Error('还没有配置视觉模型：设置 → 模型与 API → 视觉模型');
      const target = resolveTarget(args?.path, workspace);
      const data = await fs.readFile(target);
      const ext = path.extname(target).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }[ext] || 'image/jpeg';
      const base = String(vision.baseUrl || '').replace(/\/$/, '');
      const key = vision.apiKey || config.apiKey;
      const question = String(args?.question || '描述这张图片的内容、布局和问题');
      const b64 = data.toString('base64');
      let response;
      try {
        if (/anthropic|claude/i.test(base)) {
          const endpoint = /\/messages$/i.test(base) ? base : (/\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`);
          response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) },
            body: JSON.stringify({
              model: vision.model,
              max_tokens: 2048,
              messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
                { type: 'text', text: question }
              ] }]
            }),
            signal: AbortSignal.timeout(90000)
          });
        } else if (/generativelanguage|gemini/i.test(base)) {
          const endpoint = /:generateContent/i.test(base)
            ? base
            : `${base}/models/${encodeURIComponent(vision.model)}:generateContent${key ? `?key=${encodeURIComponent(key)}` : ''}`;
          response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [
                { text: question },
                { inline_data: { mime_type: mime, data: b64 } }
              ] }]
            }),
            signal: AbortSignal.timeout(90000)
          });
        } else {
          const endpoint = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
          response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
            body: JSON.stringify({
              model: vision.model,
              messages: [{ role: 'user', content: [
                { type: 'text', text: question },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
              ] }],
              max_tokens: 2048
            }),
            signal: AbortSignal.timeout(90000)
          });
        }
      } catch (error) {
        throw new Error(`视觉模型连接失败：${error.message}`);
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`视觉模型请求失败：HTTP ${response.status} ${detail.slice(0, 300)}`);
      }
      const payload = await response.json();
      let text = payload?.choices?.[0]?.message?.content
        ?? payload?.content?.map?.((item) => item.text || '').join('\n')
        ?? payload?.candidates?.[0]?.content?.parts?.map?.((item) => item.text || '').join('\n')
        ?? '';
      if (Array.isArray(text)) text = text.map((item) => item?.text || item?.content || '').join('\n');
      return String(text || '（没有返回内容）');
    }
    case 'media_info': {
      const target = resolveTarget(args?.path, workspace);
      const output = await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS_DIR, 'media_info.ps1'), '-Path', target], { timeout: 30000 });
      const info = JSON.parse(output);
      const seconds = info.durationTicks ? Math.round(info.durationTicks / 10000000) : 0;
      return `文件：${info.name}\\n大小：${info.bytes} 字节\\n时长：${seconds ? `${seconds} 秒` : '未知'}\\n分辨率：${info.width && info.height ? `${info.width}x${info.height}` : '无'}`;
    }
    case 'transcribe_audio': {
      const cfg = config.transcribe || {};
      if (!cfg.baseUrl) throw new Error('还没有配置转写模型：设置 → 模型与 API → 语音转写');
      const target = resolveTarget(args?.path, workspace);
      const data = await fs.readFile(target);
      const ext = path.extname(target).toLowerCase();
      const mime = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.flac': 'audio/flac' }[ext] || 'application/octet-stream';
      const form = new FormData();
      form.append('file', new Blob([data], { type: mime }), path.basename(target));
      form.append('model', cfg.model || 'whisper-1');
      const base = String(cfg.baseUrl || '').replace(/\/$/, '');
      const endpoint = /\/audio\/transcriptions$/i.test(base) ? base : `${base}/audio/transcriptions`;
      const key = cfg.apiKey || config.apiKey;
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: key ? { authorization: `Bearer ${key}` } : {},
          body: form,
          signal: AbortSignal.timeout(180000)
        });
      } catch (error) {
        throw new Error(`转写连接失败：${error.message}`);
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`转写失败：HTTP ${response.status} ${detail.slice(0, 300)}`);
      }
      const raw = await response.text();
      try {
        const payload = JSON.parse(raw);
        return String(payload.text || payload.transcript || payload.result || '（没有转写结果）');
      } catch {
        return String(raw || '（没有转写结果）');
      }
    }
    case 'browser_wait': {
      const selector = String(args?.selector || '');
      const text = String(args?.text || '');
      const timeout = Math.min(60000, Number(args?.timeout) || 15000);
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const found = await browserEvaluate(`(() => {
          const selector = ${JSON.stringify(selector)};
          const text = ${JSON.stringify(text)};
          if (selector && document.querySelector(selector)) return true;
          if (text && (document.body?.innerText || '').includes(text)) return true;
          return false;
        })()`);
        if (found) return `已出现：${selector || text}（${Math.round((Date.now() - started) / 1000)} 秒）`;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('等待超时');
    }
    case 'browser_press': {
      const key = String(args?.key || 'Enter');
      await browserEvaluate(`(() => {
        const target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(key)}, bubbles: true }));
        return true;
      })()`);
      return `已按键：${key}`;
    }
    case 'browser_scroll': {
      const y = Number(args?.y) || 600;
      await browserEvaluate(`window.scrollBy(0, ${y}); true`);
      return `已滚动 ${y}px`;
    }
    case 'browser_upload': {
      const selector = String(args?.selector || '');
      const paths = (Array.isArray(args?.paths) ? args.paths : []).map((item) => resolveTarget(item, workspace));
      if (!paths.length) throw new Error('缺少文件路径');
      const client = await ensureBrowser();
      const doc = await client.send('DOM.getDocument', { depth: -1 });
      const node = await client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      if (!node.nodeId) throw new Error('没有找到上传控件');
      await client.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: paths });
      return `已选择 ${paths.length} 个文件`;
    }
    case 'service_start': {
      const command = String(args?.command || '').trim();
      if (!command) throw new Error('缺少启动命令');
      const service = await startService({
        name: String(args?.name || '').slice(0, 60),
        command,
        cwd: args?.cwd ? resolveTarget(args.cwd, workspace) : workspace
      });
      return `已启动 ${service.id}：${service.name}\n日志：${service.logFile}`;
    }
    case 'service_list': {
      const list = listServices();
      return list.length
        ? list.map((item) => `${item.id} [${item.status}] ${item.name} — ${item.command.slice(0, 80)}`).join('\n')
        : '没有后台进程';
    }
    case 'service_stop': {
      const service = services.get(String(args?.id || ''));
      if (!service) throw new Error('进程不存在');
      try { service.child.kill(); } catch { /* ignore */ }
      service.status = 'stopped';
      return `已停止 ${service.id}`;
    }
    case 'service_logs': {
      const service = services.get(String(args?.id || ''));
      if (!service) throw new Error('进程不存在');
      const text = await fs.readFile(service.logFile, 'utf8').catch(() => '');
      const lines = Math.min(200, Number(args?.lines) || 60);
      return text.split('\n').slice(-lines).join('\n') || '（还没有输出）';
    }
    case 'browser_open': {
      const url = String(args?.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https 网址');
      const info = await browserNavigate(url);
      return `已打开：${info.title || '(无标题)'} — ${info.url}`;
    }
    case 'browser_read': {
      const data = await browserEvaluate('({ title: document.title, url: location.href, text: (document.body?.innerText || "").slice(0, 6000) })');
      return `标题：${data.title}\n地址：${data.url}\n\n${data.text}`;
    }
    case 'browser_click': {
      const selector = String(args?.selector || '').trim();
      const text = String(args?.text || '').trim();
      const clicked = await browserEvaluate(`(() => {
        const selector = ${JSON.stringify(selector)};
        const text = ${JSON.stringify(text)};
        let node = null;
        if (text) {
          node = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')]
            .find((el) => (el.innerText || el.value || '').includes(text)) || null;
        }
        if (!node && selector) node = document.querySelector(selector);
        if (!node) return { ok: false, error: '没有找到元素' };
        node.scrollIntoView({ block: 'center' });
        node.click();
        return { ok: true, label: (node.innerText || node.value || node.tagName).slice(0, 60) };
      })()`);
      if (!clicked.ok) throw new Error(clicked.error);
      return `已点击：${clicked.label}`;
    }
    case 'browser_type': {
      const selector = String(args?.selector || '').trim();
      const value = String(args?.text ?? '');
      const enter = Boolean(args?.enter);
      const typed = await browserEvaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return { ok: false, error: '没有找到输入框' };
        node.focus();
        if (node.isContentEditable) { node.textContent = ${JSON.stringify(value)}; }
        else {
          const setter = Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(node, ${JSON.stringify(value)}); else node.value = ${JSON.stringify(value)};
        }
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        if (${enter}) {
          node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        }
        return { ok: true };
      })()`);
      if (!typed.ok) throw new Error(typed.error);
      return `已填写：${selector}`;
    }
    case 'browser_screenshot': {
      const client = await ensureBrowser();
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      const relative = path.posix.join('browser', `shot-${Date.now()}.png`);
      const target = path.join(workspace, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(shot.data, 'base64'));
      return { text: `已截图：${relative}`, file: relative };
    }
    case 'open_in_app': {
      const target = resolveTarget(args?.path, workspace);
      await fs.access(target);
      const app = String(args?.app || '').toLowerCase();
      const map = { word: ['winword', 'Microsoft Word'], excel: ['excel', 'Microsoft Excel'], powerpoint: ['powerpnt', 'Microsoft PowerPoint'], wps: ['wps', 'WPS Office'], photoshop: ['photoshop', 'Adobe Photoshop'], premiere: ['premiere', 'Adobe Premiere Pro'] };
      const picked = map[app];
      if (app && picked) {
        let found = false;
        try { await runProcess('where.exe', [picked[0]], { timeout: 4000 }); found = true; } catch { }
        if (!found) {
          const links = { word: 'https://www.microsoft.com/microsoft-365/word', excel: 'https://www.microsoft.com/microsoft-365/excel', powerpoint: 'https://www.microsoft.com/microsoft-365/powerpoint', wps: 'https://www.wps.cn/', photoshop: 'https://www.adobe.com/products/photoshop.html', premiere: 'https://www.adobe.com/products/premiere.html' };
          return `没有检测到 ${picked[1]}。请先安装：${links[app] || '该软件的官方网站'}。安装完成后告诉我，我再调用它打开。`;
        }
      }
      const exe = picked ? picked[0] : '';
      spawn('cmd.exe', ['/c', 'start', '', ...(exe ? [exe] : []), target], {
        detached: true, stdio: 'ignore', windowsHide: true
      }).unref();
      return `已用${picked ? picked[1] : '系统默认程序'}打开 ${path.basename(target)}`;
    }
    case 'copy_to_desktop': {
      const target = resolveTarget(args?.path, workspace);
      await fs.access(target);
      let desktop = path.join(os.homedir(), 'Desktop');
      try {
        const known = (await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"], { timeout: 8000 })).trim();
        if (known && existsSync(known)) desktop = known;
      } catch { }
      await fs.mkdir(desktop, { recursive: true });
      let name = String(args?.name || path.basename(target)).replace(/[\\/:*?"<>|]/g, '_');
      let dest = path.join(desktop, name);
      if (existsSync(dest)) {
        const ext = path.extname(name);
        const base = path.basename(name, ext);
        dest = path.join(desktop, `${base}-${Date.now()}${ext}`);
      }
      await fs.copyFile(target, dest);
      return { text: `已放到桌面：${dest}`, file: dest };
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

/* ------------------------------------------------------------- agent loop */

const TOOL_POLICY = `

工具调用优先级（必须遵守）：
1. 只要 Nalo 内置工具能完成，必须优先使用内置工具，不要调用本机命令或外部程序。
2. 没有合适的内置工具时，先用 ask_user 询问用户“是否允许我使用你电脑上的某个工具/程序”，得到明确同意后才执行。
3. 用户明确点名要用哪个工具、哪种方式时，严格使用用户指定的工具，不要替换成别的。
4. 用户明确说“用我电脑里的工具/本机工具/本地程序”时，直接使用本机工具，不再重复询问。
5. 以上都没有时，一律使用 Nalo 自带工具；不要假设本机安装了 Python、Node 或某个软件。
6. 需要运行网页时优先用 preview_file，不要自己起 python -m http.server。
7. 需要本机程序时，先在 ask_user 里说清楚“要用你电脑上的哪个程序、做什么”，得到同意后再调用；用户点名了程序就必须用那个程序。
8. 调用前先检测程序是否存在。没有安装时，直接告诉用户程序名称、官方下载地址和安装后如何继续，不要假装已经打开，也不要偷偷换成别的软件。
9. 浏览器任务优先使用用户电脑上的 Chrome/Edge；用 browser_open / browser_click / browser_type 操作。遇到登录、验证码、脚本被拦截、权限弹窗，停止自动化并明确告诉用户需要手动操作，不要绕过。
10. 任务完成后必须告诉用户成品在哪里：工作区路径、桌面路径、文件名。不能只说“完成了”。
11. 不要声称内置了 Office、PS、剪映等软件；这些一律调用用户本机程序。
12. 用户说“放到桌面”时，必须调用 copy_to_desktop 复制文件，并在回答里给出真实桌面路径，不能只说已放到工作区。
`;

function buildMessages(session) {
  const raw = session.messages.slice(-(Number(config.contextMessages) || 200));
  const trimmed = [];
  const skipToolIds = new Set();
  const thinkingMode = Boolean(config.thinkingLevel && config.thinkingLevel !== 'none');
  for (const message of raw) {
    if (thinkingMode && message.role === 'assistant' && !message.tool_calls && !message.reasoning_content) {
      for (const call of message.tool_calls || []) skipToolIds.add(call.id);
      continue;
    }
    if (message.role === 'tool' && skipToolIds.has(message.tool_call_id)) continue;
    trimmed.push(message);
  }
  const toolHint = config.localModelEnabled
    ? '\n\n重要：需要执行操作时必须调用工具（tool_calls），不要用文字描述伪代码或函数名。'
    : '';
  const memoryBlock = memoryNotes.length
    ? `\n\n长期记忆（用户偏好与约定）：\n${memoryNotes.map((note) => `- ${note.text}`).join('\n')}`
    : '';
  return [{ role: 'system', content: config.systemPrompt + TOOL_POLICY + toolHint + memoryBlock }, ...trimmed];
}

function approvalInfo(call, args, target) {
  const name = call.name || '';
  const url = String(args?.url || '');
  const command = String(args?.command || '');
  if (name === 'browser_open' || name === 'browser_read' || name === 'browser_click' || name === 'browser_type') {
    return { summary: '允许 Agent 操作浏览器吗？', detail: url ? `要访问：${url}` : '要在浏览器里执行点击或输入。' };
  }
  if (name === 'open_url') return { summary: '允许打开这个网页吗？', detail: url || target };
  if (name === 'look_screen') return { summary: '允许 Agent 查看当前屏幕吗？', detail: '会读取屏幕内容来确认结果。' };
  if (name === 'generate_image') return { summary: '允许生成图片吗？', detail: String(args?.prompt || '').slice(0, 200) };
  if (name === 'read_image' || name === 'analyze_image' || name === 'ocr_image') return { summary: '允许读取这张图片吗？', detail: target };
  if (name === 'read_file' || name === 'list_files' || name === 'read_document') return { summary: '允许读取这个文件吗？', detail: `文件：${target}` };
  if (name === 'write_file') return { summary: '允许写入这个文件吗？', detail: `文件：${target}` };
  if (name === 'create_document') return { summary: '允许创建这个文档吗？', detail: `文档：${target}` };
  if (name === 'edit_document') return { summary: '允许修改这个文档吗？', detail: `文档：${target}` };
  if (name === 'run_command') return { summary: '允许执行这条命令吗？', detail: `命令：${command.slice(0, 300)}` };
  if (name === 'open_in_app') return { summary: '允许用本机程序打开这个文件吗？', detail: `文件：${target}` };
  if (name.startsWith('mcp__')) return { summary: '允许调用外部工具吗？', detail: name };
  return { summary: `允许执行 ${name || '这个操作'} 吗？`, detail: target };
}

async function ensureFileAccess({ emit, runState, call, args, elapsed, workspace }) {
  if (runState.autoApprove) return true;
  if (config.permission === 'open') return true;
  if (config.permission === 'forbidden') return false;
  if (runState.approved) return true;
  const target = String(args?.path || '.');
  const deniedKey = `${call.name}:${target}`;
  if (runState.denied?.has(deniedKey)) return false;
  let drive = '';
  try { drive = driveOf(resolveTarget(target, workspace)); } catch { drive = ''; }
  const questionId = crypto.randomUUID();
  const pending = waitForAnswer(questionId);
  const info = approvalInfo(call, args, target);
  emit('approval', {
    id: questionId, tool: call.name, path: target, drive,
    summary: info.summary, detail: info.detail,
    location: String(args?.path || args?.url || args?.file || target || ''),
    workspace, elapsedMs: elapsed()
  });
  const answer = await pending;
  const allowed = /^(允许|同意|确认|可以|yes|allow|ok)/i.test(String(answer).trim());
  if (allowed) runState.approved = true;
  else runState.denied?.add(deniedKey);
  if (allowed) runState.approved = true;
  audit({ type: 'approval', tool: call.name, path: target, allowed }).catch(() => {});
  return allowed;
}

function describeCall(name, args) {
  if (!args) return '';
  if (name === 'write_file') return String(args.path || '');
  if (name === 'read_file' || name === 'list_files') return String(args.path || '.');
  if (name === 'web_search') return String(args.query || '');
  if (name === 'fetch_url') return String(args.url || '');
  if (name === 'ask_user') return String(args.question || '');
  return '';
}

async function summarizeMessages(transcript) {
  const local = config.localModelEnabled;
  const endpoint = local
    ? `${LOCAL_MODEL_URL.replace(/\/$/, '')}/chat/completions`
    : providerEndpoint(config.baseUrl, '/chat/completions');
  const headers = { 'content-type': 'application/json' };
  if (!local) headers.authorization = `Bearer ${config.apiKey}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: local ? LOCAL_MODEL_NAME : config.model,
      messages: [
        { role: 'system', content: '你是对话压缩器。把下面的对话压缩成十条以内的要点，保留用户目标、关键决定、文件与命令结果。' },
        { role: 'user', content: transcript.slice(0, 24000) }
      ],
      max_tokens: 800,
      temperature: 0.2,
      stream: false
    })
  });
  if (!response.ok) throw new Error(`压缩失败：HTTP ${response.status}`);
  const data = await response.json();
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

async function compressSessionContext(session) {
  const messages = session.messages || [];
  if (messages.length <= 12) return false;
  const keep = messages.slice(-12);
  const older = messages.slice(0, -12);
  const transcript = older.map((message) => {
    if (message.role === 'tool') return `[工具结果] ${String(message.content || '').slice(0, 500)}`;
    return `${message.role === 'user' ? '用户' : '助手'}：${String(message.content || '').slice(0, 1200)}`;
  }).join('\n');
  let summary = '';
  try {
    summary = await summarizeMessages(transcript);
  } catch {
    summary = '（较早对话已压缩，仅保留最近内容）';
  }
  session.messages = [
    { role: 'system', content: `此前对话摘要：\n${summary || '（无摘要）'}` },
    ...keep
  ];
  session.tokenUsage = 0;
  session.compressedAt = Date.now();
  session.updatedAt = Date.now();
  saveSessionsSoon();
  return true;
}

async function runAgent({ session, runId, emit, signal, autoApprove = false, automationMode = false }) {
  const started = Date.now();
  const workspace = await ensureSessionWorkspace(session);
  await ensureMcpClients().catch(() => {});
  const runState = { approved: false, denied: new Set(), autoApprove };
  const drainQueued = () => {
    const list = queuedChats.get(session.id);
    if (!list || !list.length) return false;
    queuedChats.delete(session.id);
    for (const text of list) {
      session.messages.push({ role: 'user', content: text });
      emit('user-message', { text });
    }
    session.updatedAt = Date.now();
    saveSessionsSoon();
    return true;
  };
  const elapsed = () => Date.now() - started;
  const activity = (phase, label, detail = '') => emit('activity', { phase, label, detail, elapsedMs: elapsed() });
  const thinkingBudget = Math.max(0, Number(config.thinkingLimit) || 0);

  let iterations = 0;
  let usage = { promptTokens: 0, completionTokens: 0 };
  let answerText = '';
  let finalContent = '';
  let thinkingUsed = 0;
  let lastDraftSave = 0;
  session.draft = '';
  let reasoningChars = 0;
  activity('thinking', '正在思考中');

  drainQueued();
  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations += 1;
    let response;
    try {
      response = await providerStream({ messages: buildMessages(session), tools: buildTools(), signal });
    } catch (error) {
      const text = String(error?.message || '');
      if (/tool_calls.*followed|insufficient tool messages/i.test(text)) {
        session.messages = session.messages.filter((message) => message.role === 'system' || message.role === 'user' || (message.role === 'assistant' && !message.tool_calls));
        response = await providerStream({ messages: buildMessages(session), tools: buildTools(), signal });
      } else if (/reasoning_content/i.test(text)) {
        session.messages = session.messages.filter((message) => message.role === 'system' || message.role === 'user');
        response = await providerStream({ messages: buildMessages(session), tools: buildTools(), signal });
      } else {
        throw error;
      }
    }
    let content = '';
    let reasoning = '';
    const toolCalls = new Map();
    let aborted = null;

    try {
      for await (const chunk of parseSse(response)) {
        const choice = chunk?.choices?.[0];
        const delta = choice?.delta || {};
        if (chunk?.usage) {
          const promptTokens = chunk.usage.prompt_tokens ?? chunk.usage.input_tokens ?? 0;
          const completionTokens = chunk.usage.completion_tokens ?? chunk.usage.output_tokens ?? 0;
          usage.promptTokens = promptTokens || usage.promptTokens;
          usage.completionTokens = completionTokens || usage.completionTokens;
          recordUsage(promptTokens, completionTokens);
        }

        const reasoningDelta = delta.reasoning_content || delta.reasoning;
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          reasoningChars += reasoningDelta.length;
          if (!thinkingBudget || thinkingUsed < thinkingBudget) {
            const room = thinkingBudget ? thinkingBudget - thinkingUsed : reasoningDelta.length;
            const piece = reasoningDelta.slice(0, Math.max(0, room));
            if (piece) emit('thinking', { text: piece });
            thinkingUsed += piece.length;
            if (thinkingBudget && thinkingUsed >= thinkingBudget) {
              activity('thinking', '思考达到上限', `${thinkingBudget}`);
            }
          }
        }

        if (delta.content) {
          content += delta.content;
          session.draft = (session.draft || '') + delta.content;
          if (Date.now() - lastDraftSave > 400) { lastDraftSave = Date.now(); saveSessionsNow(); }
          emit('content', { text: delta.content });
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const index = call.index ?? 0;
            const current = toolCalls.get(index) || { id: '', name: '', arguments: '' };
            if (call.id) current.id = call.id;
            if (call.function?.name) current.name += call.function.name;
            if (call.function?.arguments) current.arguments += call.function.arguments;
            toolCalls.set(index, current);
          }
        }
      }
    } catch (error) {
      aborted = error;
    }

    const thinkMatch = content.match(/^([\s\S]*?)<\/think>([\s\S]*)$/i);
    if (!reasoning && thinkMatch) {
      reasoning = thinkMatch[1].replace(/^[\s\S]*?<think>/i, '').trim();
      content = thinkMatch[2].trim();
      emit('thinking-reset', { text: reasoning });
      emit('content-reset', { text: content });
    }

    if (aborted) {
      if (content.trim()) {
        session.draft = '';
        session.messages.push({ role: 'assistant', content: content.trim(), ...(reasoning.trim() ? { reasoning_content: reasoning.trim() } : {}) });
        session.updatedAt = Date.now();
        saveSessionsSoon();
      }
      throw aborted;
    }

    answerText += content;
    session.draft = '';
    const reasoningText = reasoning.trim();
    if (content.trim() && !toolCalls.size) session.messages.push({ role: 'assistant', content: content.trim(), ...(reasoningText ? { reasoning_content: reasoningText } : {}) });
    if (!toolCalls.size) {
      finalContent = content;
      if (drainQueued()) continue;
      break;
    }

    const calls = [...toolCalls.values()].filter((call) => call.name);
    session.messages.push({
      role: 'assistant',
      content: content.trim() || null,
      ...(reasoningText ? { reasoning_content: reasoningText } : { reasoning_content: ' ' }),
      tool_calls: calls.map((call) => ({
        id: call.id || crypto.randomUUID(),
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' }
      }))
    });

    let askedUser = false;
    for (const call of calls) {
      let args = {};
      try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { args = {}; }
      const detail = describeCall(call.name, args);
      session.tools = session.tools || {};
      session.tools[call.name] = (session.tools[call.name] || 0) + 1;
      emit('tool-start', { id: call.id, name: call.name, args, detail, elapsedMs: elapsed() });
      audit({ type: 'tool', sessionId: session.id, tool: call.name, detail }).catch(() => {});
      activity('tool', call.name, detail);

      let resultText;
      let ok = true;
      try {
        if (call.name === 'create_automation') {
          const owner = account?.username || '';
          if (!owner) throw new Error('请先登录');
          const title = String(args?.title || '').trim().slice(0, 120);
          const prompt = String(args?.prompt || '').trim().slice(0, 20000);
          if (!title || !prompt) throw new Error('任务名称和执行内容不能为空');
          const type = ['once', 'interval', 'daily', 'weekly', 'manual'].includes(args?.type) ? args.type : 'manual';
          const task = { id: crypto.randomUUID(), owner, title, prompt, type, enabled: true, access: args?.access === 'confirm' ? 'confirm' : 'open', createdAt: Date.now(), updatedAt: Date.now(), runAt: 0, intervalMinutes: Math.max(1, Number(args?.intervalMinutes) || 60), time: /^\d{2}:\d{2}$/.test(String(args?.time || '')) ? String(args.time) : '09:00', weekdays: Array.isArray(args?.weekdays) ? [...new Set(args.weekdays.map(Number).filter((n) => n >= 0 && n <= 6))] : [1,2,3,4,5] };
          if (type === 'once') {
            const parsed = /^\d+$/.test(String(args?.runAt || '')) ? Number(args.runAt) : Date.parse(String(args?.runAt || ''));
            if (!Number.isFinite(parsed) || parsed <= Date.now()) throw new Error('一次性任务需要未来的执行时间');
            task.runAt = parsed;
          }
          task.nextRunAt = automationNextRun(task, Date.now());
          automations.unshift(task);
          await saveAutomations();
          resultText = `已创建自动化任务：${title}（${automationSummary(task)}）`;
        } else if (call.name === 'set_plan') {
          const steps = Array.isArray(args?.steps) ? args.steps.map(String).slice(0, 20) : [];
          session.plan = steps;
          session.updatedAt = Date.now();
          saveSessionsSoon();
          emit('plan', { steps, elapsedMs: elapsed() });
          emit('tool-end', { id: call.id, name: call.name, ok: true, preview: `${steps.length} 步`, elapsedMs: elapsed() });
          resultText = `计划已记录：${steps.join(' / ')}`;
        } else if (call.name === 'ask_user') {
          askedUser = true;
          if (automationMode) {
            emit('tool-end', { id: call.id, name: call.name, ok: true, preview: '自动化任务自行判断并继续', elapsedMs: elapsed() });
            resultText = '自动化任务自行判断并继续完成，不需要等待用户回答。';
            session.messages.push({ role: 'tool', tool_call_id: call.id || crypto.randomUUID(), content: resultText });
            emit('tool-result', { id: call.id, name: call.name, ok: true, preview: resultText });
            continue;
          }
          const questionId = crypto.randomUUID();
          const options = Array.isArray(args.options) ? args.options.slice(0, 6).map(String) : [];
          const pending = waitForAnswer(questionId);
          emit('ask', { id: questionId, question: String(args.question || '需要你确认'), options, elapsedMs: elapsed() });
          const answer = await pending;
          emit('tool-end', { id: call.id, name: call.name, ok: true, preview: answer, elapsedMs: elapsed() });
          resultText = `用户回答：${answer}`;
        } else {
          if (SENSITIVE_TOOLS.has(call.name)) {
            const allowed = await ensureFileAccess({ emit, runState, call, args, elapsed, workspace });
            if (!allowed) {
              emit('tool-end', {
                id: call.id, name: call.name, ok: false,
                preview: config.permission === 'forbidden' ? '访问权限为禁止' : '用户未允许访问',
                elapsedMs: elapsed()
              });
              session.messages.push({
                role: 'tool', tool_call_id: call.id || crypto.randomUUID(),
                content: '用户已拒绝这次访问。不要再次请求同一个工具和路径；请先说明“用户已拒绝，正在思考其他执行方式”，然后尝试不依赖该权限的替代方案；如果确实没有替代方案，直接告诉用户“由于您拒绝访问，因此我无法执行”。'
              });
              continue;
            }
          }
          let outcome;
          if (call.name === 'web_search') outcome = await webSearch(args.query, args.count);
          else if (call.name === 'fetch_url') outcome = await fetchUrlText(args.url);
          else outcome = await runTool(call.name, args, workspace);

          if (outcome && typeof outcome === 'object') {
            emit('tool-end', { id: call.id, name: call.name, ok: true, preview: outcome.text, file: outcome.file, elapsedMs: elapsed() });
            if (outcome.file) emit('file-changed', { path: outcome.file });
            resultText = outcome.text;
            if (outcome.file) activity('write', '写入文件', `${outcome.file} · ${driveOf(resolveTarget(outcome.file, workspace))}`);
          } else {
            const preview = String(outcome).slice(0, 400);
            emit('tool-end', { id: call.id, name: call.name, ok: true, preview, elapsedMs: elapsed() });
            resultText = String(outcome);
          }
        }
      } catch (error) {
        ok = false;
        emit('tool-end', { id: call.id, name: call.name, ok: false, preview: error.message, elapsedMs: elapsed() });
        resultText = `工具执行失败：${error.message}`;
      }
      if (ok) activity('tool-done', '完成调用', call.name);
      session.messages.push({
        role: 'tool',
        tool_call_id: call.id || crypto.randomUUID(),
        content: resultText.slice(0, 20000)
      });
    }

    if (askedUser && iterations >= MAX_TOOL_ITERATIONS) break;
    session.updatedAt = Date.now();
    saveSessionsSoon();
  }

  if (!usage.promptTokens && !usage.completionTokens) {
    const promptChars = session.messages.reduce((sum, message) => {
      if (typeof message.content === 'string') return sum + message.content.length;
      if (Array.isArray(message.content)) return sum + message.content.reduce((acc, part) => acc + String(part.text || '').length, 0);
      return sum;
    }, 0);
    const promptEstimate = Math.max(1, Math.round(promptChars / 3.2));
    const completionEstimate = Math.max(1, Math.round((answerText.length + reasoningChars) / 3.2));
    usage.promptTokens = promptEstimate;
    usage.completionTokens = completionEstimate;
    recordUsage(promptEstimate, completionEstimate);
  }

  session.tokenUsage = (session.tokenUsage || 0) + usage.promptTokens + usage.completionTokens;
  if (session.tokenUsage >= (Number(config.compressAfterTokens) || 100000000)) {
    emit('compressing', { tokenUsage: session.tokenUsage });
    const compressed = await compressSessionContext(session).catch(() => false);
    if (compressed) emit('compressed', { tokenUsage: session.tokenUsage, messageCount: session.messages.length });
  }

  emit('done', { usage, iterations, runId, elapsedMs: elapsed(), text: finalContent, limitReached: !finalContent && iterations >= MAX_TOOL_ITERATIONS });
  return { answerText, usage };
}

function waitForAnswer(questionId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingQuestions.delete(questionId);
      reject(new Error('等待用户回答超时'));
    }, ANSWER_TIMEOUT_MS);
    pendingQuestions.set(questionId, (value) => {
      clearTimeout(timer);
      pendingQuestions.delete(questionId);
      resolve(value);
    });
  });
}

/* ---------------------------------------------------------------- routes */

async function serveStatic(res, urlPath) {
  const clean = urlPath === '/' ? '/index.html' : urlPath;
  const target = path.join(WEB, decodeURIComponent(clean));
  if (!target.startsWith(WEB)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': data.length
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}


/* ------------------------------------------------------------ updates */

const UPDATE_MANIFEST_URL = process.env.NALO_UPDATE_MANIFEST || 'https://nalo.work/update.json';
let updateManifestCache = { at: 0, data: null };

async function fetchUpdateManifest() {
  if (Date.now() - updateManifestCache.at < 5 * 60e3) return updateManifestCache.data;
  try {
    const separator = UPDATE_MANIFEST_URL.includes('?') ? '&' : '?';
    const response = await fetch(`${UPDATE_MANIFEST_URL}${separator}t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = await response.json();
      updateManifestCache = { at: Date.now(), data };
      return data;
    }
  } catch { /* offline: fall back to local config */ }
  updateManifestCache = { at: Date.now(), data: null };
  return null;
}

async function getUpdateConfig() {
  let local = {};
  try { local = JSON.parse(await fs.readFile(path.join(DATA, 'update.json'), 'utf8')); } catch { local = {}; }
  const remote = await fetchUpdateManifest();
  if (remote && typeof remote === 'object') return remote;
  return local;
}

const updateState = { status: 'idle', received: 0, total: 0, percent: 0, error: '', file: '' };
let updateDownloading = false;

async function recoverPendingUpdate() {
  const pendingFile = path.join(DATA, 'update-pending.json');
  try {
    const pending = JSON.parse(await fs.readFile(pendingFile, 'utf8'));
    for (const item of pending.files || []) {
      if (!item.backup || !existsSync(item.backup)) continue;
      const target = path.resolve(ROOT, item.path);
      if (!target.startsWith(path.resolve(ROOT) + path.sep)) continue;
      await fs.copyFile(item.backup, target).catch(() => {});
    }
    await fs.unlink(pendingFile).catch(() => {});
    console.log('[update] 检测到未完成的增量更新，已回滚');
  } catch { /* nothing pending */ }
}

async function downloadDelta(url, expectedVersion, expectedSha) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`增量包下载失败：HTTP ${response.status}`);
  const text = await response.text();
  if (expectedSha) {
    const actual = crypto.createHash('sha256').update(text).digest('hex');
    if (actual !== expectedSha) throw new Error('增量包校验失败，已放弃');
  }
  const data = JSON.parse(text);
  if (String(data.version || '') !== String(expectedVersion)) throw new Error('增量包版本不匹配');
  const files = data.files || {};
  const root = path.resolve(ROOT);
  const staging = path.join(os.tmpdir(), `nalo-delta-${expectedVersion}-${Date.now()}`);
  const backupDir = path.join(DATA, 'update-backup', expectedVersion);
  await fs.mkdir(staging, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });
  const staged = [];
  for (const [relative, entry] of Object.entries(files)) {
    if (!relative || relative.includes('..') || path.isAbsolute(relative)) throw new Error(`增量包路径非法：${relative}`);
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) throw new Error(`增量包路径越界：${relative}`);
    const content = entry.encoding === 'base64' ? Buffer.from(entry.data, 'base64') : Buffer.from(String(entry.data), 'utf8');
    if (entry.sha256) {
      const actual = crypto.createHash('sha256').update(content).digest('hex');
      if (actual !== entry.sha256) throw new Error(`文件校验失败：${relative}`);
    }
    const tempTarget = path.join(staging, relative);
    await fs.mkdir(path.dirname(tempTarget), { recursive: true });
    await fs.writeFile(tempTarget, content);
    staged.push({ relative, target, tempTarget, backup: path.join(backupDir, relative) });
  }
  const pendingFile = path.join(DATA, 'update-pending.json');
  const pending = { version: expectedVersion, files: [] };
  for (const item of staged) {
    const exists = existsSync(item.target);
    if (exists) {
      await fs.mkdir(path.dirname(item.backup), { recursive: true });
      await fs.copyFile(item.target, item.backup);
    }
    pending.files.push({ path: item.relative, backup: exists ? item.backup : '' });
  }
  await fs.writeFile(pendingFile, JSON.stringify(pending, null, 2), 'utf8');
  try {
    for (const item of staged) {
      await fs.mkdir(path.dirname(item.target), { recursive: true });
      await fs.copyFile(item.tempTarget, item.target);
    }
    await fs.unlink(pendingFile).catch(() => {});
  } catch (error) {
    for (const item of pending.files) {
      if (item.backup && existsSync(item.backup)) await fs.copyFile(item.backup, path.resolve(ROOT, item.path)).catch(() => {});
    }
    await fs.unlink(pendingFile).catch(() => {});
    throw error;
  }
  return staged.map((item) => item.relative);
}

async function downloadUpdate() {
  if (updateDownloading) return;
  updateDownloading = true;
  updateState.status = 'downloading';
  updateState.error = '';
  try {
    const config = await getUpdateConfig();
    const latest = String(config.latest || '');
    const deltaUrl = String(config.deltaUrl || '');
    if (deltaUrl) {
      try {
        Object.assign(updateState, { status: 'downloading', received: 0, total: Number(config.deltaSize) || 0, percent: 5, file: '', mode: 'delta' });
        const files = await downloadDelta(deltaUrl, latest, String(config.deltaSha256 || ''));
        Object.assign(updateState, { status: 'ready', mode: 'delta', percent: 100, received: 1, total: 1, error: '', file: '', deltaFiles: files });
        return;
      } catch (error) {
        updateState.error = `增量更新失败，改用完整包：${error.message}`;
      }
    }
    updateState.mode = 'full';
    const url = String(config.downloadUrl || '');
    if (!/^https?:\/\//i.test(url)) throw new Error('更新地址无效');
    const dir = path.join(os.tmpdir(), 'NaloCode-update');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, path.basename(new URL(url).pathname) || 'NaloCode-Setup.exe');
    let received = 0;
    try { received = (await fs.stat(file)).size; } catch { received = 0; }
    updateState.file = file;
    updateState.received = received;
    updateState.total = 0;
    updateState.percent = 0;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const headers = received > 0 ? { range: `bytes=${received}-` } : {};
        const response = await fetch(url, { cache: 'no-store', headers, signal: AbortSignal.timeout(1800000) });
        if (response.status === 416 && received > 0) {
          received = 0;
          updateState.received = 0;
          continue;
        }
        if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
        const partial = response.status === 206;
        const length = Number(response.headers.get('content-length')) || 0;
        if (!partial) {
          received = 0;
          updateState.received = 0;
        }
        const total = partial ? received + length : length;
        updateState.total = total;
        const handle = await fs.open(file, received > 0 && partial ? 'a' : 'w');
        const reader = response.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            await handle.write(value);
            received += value.length;
            updateState.received = received;
            updateState.total = total;
            updateState.percent = total ? Math.min(99, Math.round(received / total * 100)) : 0;
          }
        } finally {
          await handle.close();
        }
        if (total && received < total) throw new Error('下载中断，请重试续传');
        Object.assign(updateState, { status: 'ready', mode: 'full', percent: 100, total: received, received, file });
        return;
      } catch (error) {
        const message = error?.name === 'TimeoutError'
          ? '下载超时，已保留进度，可点击重试续传'
          : `下载失败：${error.message}。已保留进度，可重试续传`;
        Object.assign(updateState, { status: 'error', error: message, received, file });
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
  } catch (error) {
    Object.assign(updateState, { status: 'error', error: error.message });
  } finally {
    updateDownloading = false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const license = await licenseGate();
  const licenseExempt = pathname === '/api/state'
    || pathname.startsWith('/api/license')
    || pathname === '/api/captcha'
    || pathname === '/api/updates' || pathname.startsWith('/api/update/')
    || pathname === '/api/email/code'
    || pathname === '/api/login' || pathname === '/api/login/email-code' || pathname === '/api/logout'
    || pathname === '/api/account/register'
    || pathname === '/api/app'
    || !pathname.startsWith('/api/');
  if (!license.licensed && !licenseExempt) {
    return json(res, 402, { error: 'license_required', reason: license.reason });
  }

  const authExempt = pathname === '/api/maintenance' || pathname === '/api/state'
    || pathname.startsWith('/api/license')
    || pathname === '/api/captcha'
    || pathname === '/api/updates' || pathname.startsWith('/api/update/')
    || pathname === '/api/email/code'
    || pathname === '/api/login' || pathname === '/api/login/email-code' || pathname === '/api/logout'
    || pathname === '/api/account/register'
    || pathname === '/api/app';
  const activeUser = currentUsername(req);
  if (!activeUser && pathname.startsWith('/api/') && !authExempt) {
    return json(res, 401, { error: '请先登录' });
  }
  const maintenanceExempt = pathname === '/api/maintenance'
    || pathname === '/api/login' || pathname === '/api/login/email-code' || pathname === '/api/logout'
    || pathname === '/api/captcha' || pathname === '/api/app'
    || pathname === '/api/state' || pathname.startsWith('/api/license');
  if (maintenanceState.enabled && pathname.startsWith('/api/') && !maintenanceExempt) {
    const role = account?.role || users.find((item) => item.username === activeUser)?.role;
    if (role !== 'admin') {
      return json(res, 503, { error: maintenanceState.message || '系统维护中', maintenance: true, message: maintenanceState.message || '系统维护中' });
    }
  }

  const activeRecord = users.find((item) => item.username === activeUser);
  if (activeRecord && isBanned(activeRecord) && !authExempt) {
    const token = parseCookies(req).flow_auth;
    if (token) { authTokens.delete(token); saveAuthTokens(); }
    res.setHeader('set-cookie', 'flow_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return json(res, 403, { error: banMessage(activeRecord), banned: true, bannedUntil: activeRecord.bannedUntil || 0, banPermanent: Boolean(activeRecord.banPermanent) });
  }



  if (pathname === '/site' || pathname.startsWith('/site/')) {
    const relative = pathname.replace(/^\/site\/?/, '') || 'index.html';
    const file = path.join(ROOT, 'site', relative);
    try {
      const data = await fs.readFile(file);
      const ext = path.extname(file).toLowerCase();
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
      res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
      return res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('页面不存在');
    }
  }




  if (req.method === 'GET' && pathname === '/api/maintenance') {
    return json(res, 200, { enabled: maintenanceState.enabled, message: maintenanceState.message });
  }
  if (req.method === 'POST' && pathname === '/api/admin/maintenance') {
    if (!currentUsername(req) || account?.role !== 'admin') return json(res, 403, { error: '仅管理员可用' });
    const body = await readBody(req);
    if (body.enabled !== undefined) maintenanceState.enabled = Boolean(body.enabled);
    if (body.message !== undefined) maintenanceState.message = String(body.message || '').slice(0, 500) || '系统维护中，请稍后再试。';
    await fs.mkdir(DATA, { recursive: true });
    await fs.writeFile(MAINTENANCE_FILE, JSON.stringify(maintenanceState, null, 2), 'utf8');
    return json(res, 200, { maintenance: maintenanceState });
  }
  if (req.method === 'POST' && pathname === '/api/update/start') {
    if (updateState.status !== 'downloading') downloadUpdate();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname === '/api/update/status') {
    return json(res, 200, updateState);
  }
  if (req.method === 'POST' && pathname === '/api/update/install') {
    if (updateState.status !== 'ready' || (updateState.mode !== 'delta' && (!updateState.file || !existsSync(updateState.file)))) {
      return json(res, 400, { error: '安装包还没准备好' });
    }
    if (updateState.mode === 'delta') {
      const batPath = path.join(os.tmpdir(), `nalo-restart-${Date.now()}.bat`);
      const lines = ['@echo off', 'taskkill /F /IM NaloCode.exe >nul 2>&1', 'timeout /t 1 /nobreak >nul', `start "" "${path.join(ROOT, 'NaloCode.exe')}"`];
      try {
        fsSync.writeFileSync(batPath, lines.join('\r\n'), 'utf8');
        spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch (error) {
        return json(res, 500, { error: `无法重启应用：${error.message}` });
      }
      setTimeout(() => process.exit(0), 1200);
      return json(res, 200, { ok: true });
    }
    let size = 0;
    try { size = fsSync.statSync(updateState.file).size; } catch { size = 0; }
    if (size < 1024 * 1024) return json(res, 400, { error: '安装包不完整，请重新下载' });
    const file = updateState.file;
    const batPath = path.join(os.tmpdir(), `nalo-update-${Date.now()}.bat`);
    const lines = [
      '@echo off',
      'taskkill /F /IM NaloCode.exe >nul 2>&1',
      'timeout /t 2 /nobreak >nul',
      `start "" /wait "${file}" /SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /FORCECLOSEAPPLICATIONS /DIR=${ROOT}`,
      `start "" "${path.join(ROOT, 'NaloCode.exe')}"`
    ];
    try {
      fsSync.writeFileSync(batPath, lines.join('\r\n'), 'utf8');
      const helper = spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true });
      helper.unref();
    } catch (error) {
      return json(res, 500, { error: `无法启动更新程序：${error.message}` });
    }
    setTimeout(() => process.exit(0), 1200);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/updates') {
    const updateConfig = await getUpdateConfig();
    const notes = Array.isArray(updateConfig.notes) && updateConfig.notes.length ? updateConfig.notes : [
      { version: '1.2.0', date: '2026-11-10', items: [
        '新增 15 种语言代码编译与运行',
        'PDF 原位改字、扫描件 OCR 改字',
        'Office 深度编辑：Word / Excel / PPT',
        '浏览器自动化：点击、填表、上传、等待',
        '后台任务与常驻进程管理',
        '分享链接、权限审计、长期记忆',
        '工作区筛选、文件图标与下载/删除'
      ] }
    ];
    const latest = String(updateConfig.latest || APP_VERSION);
    const site = String(process.env.NALO_SITE_URL || updateConfig.siteUrl || '');
    const configured = String(process.env.NALO_UPDATE_URL || updateConfig.downloadUrl || '');
    const localName = `NaloCode-${latest}-Setup.exe`;
    const localExists = existsSync(path.join(ROOT, 'dist', localName));
    const download = configured || (localExists ? `/download/${localName}` : (site ? `${site.replace(/\/$/, '')}/download/${localName}` : ''));
    return json(res, 200, { current: APP_VERSION, latest, notes, download, site });
  }

  if (pathname.startsWith('/download/')) {
    const name = pathname.slice('/download/'.length).replace(/[^\w.\-]/g, '');
    const file = path.join(ROOT, 'dist', name);
    try {
      const stat = await fs.stat(file);
      const stream = (await import('node:fs')).createReadStream(file);
      stream.on('error', (error) => {
        console.error('[download]', error.message);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('读取安装包失败');
      });
      res.writeHead(200, {
        'content-type': name.endsWith('.exe') ? 'application/vnd.microsoft.portable-executable' : 'application/octet-stream',
        'content-length': stat.size,
        'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      return stream.pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('安装包还未生成');
    }
  }



  if (req.method === 'GET' && pathname.startsWith('/share/')) {
    const token = pathname.slice('/share/'.length);
    const share = shares[token];
    if (!share) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<h1>链接不存在或已失效</h1>');
    }
    const session = sessions.find((item) => item.id === share.sessionId);
    if (!session) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<h1>对话已删除</h1>');
    }
    const escape = (value) => String(value || '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
    const blocks = (session.messages || []).map((message) => {
      if (message.role === 'user') return `<div class="msg user">${escape(message.content)}</div>`;
      if (message.role === 'assistant' && message.content) return `<div class="msg bot">${escape(message.content)}</div>`;
      return '';
    }).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escape(session.title || 'Nalo Code 对话')}</title>
<style>body{margin:0;background:#f6f6f7;font-family:"Microsoft YaHei UI",system-ui;color:#17181b}
main{max-width:760px;margin:0 auto;padding:48px 24px 80px}
h1{font-size:20px;font-weight:600;margin:0 0 6px}.sub{color:#8a8b92;font-size:12px;margin-bottom:32px}
.msg{font-size:14px;line-height:1.85;white-space:pre-wrap;margin:0 0 18px}
.user{color:#5b5c64}.bot{color:#17181b}
footer{margin-top:40px;font-size:11px;color:#9a9ba2}</style></head>
<body><main><h1>${escape(session.title || '对话')}</h1><div class="sub">Nalo Code 对话分享 · ${new Date(share.createdAt).toLocaleString()}</div>${blocks}<footer>由 Nalo Code 生成</footer></main></body></html>`);
  }



  try {
    if (req.method === 'GET' && pathname === '/api/license') {
      return json(res, 200, await licenseGate());
    }
    if (req.method === 'POST' && pathname === '/api/license/activate') {
      const body = await readBody(req);
      try {
        return json(res, 200, await activateLicense(body.key));
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (req.method === 'GET' && pathname === '/api/license/captcha') {
      try { return json(res, 200, await licenseCaptcha()); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'POST' && pathname === '/api/license/sms') {
      const body = await readBody(req);
      try { return json(res, 200, await licenseSendSms(body)); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'POST' && pathname === '/api/license/register') {
      const body = await readBody(req);
      try { return json(res, 200, await licenseRegister(body)); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'POST' && pathname === '/api/license/auto') {
      try {
        return json(res, 200, await autoActivateLicense());
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
    if (req.method === 'POST' && pathname === '/api/license/refresh') {
      sessionVerified = false;
      if (controlAbort) { try { controlAbort.abort(); } catch { /* ignore */ } controlAbort = null; }
      const summary = await ensureSession(true);
      licenseCache = { at: Date.now(), summary };
      return json(res, 200, summary);
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      const activeUser = currentUsername(req);
      const safeConfig = activeUser && !isBanned(account)
        ? publicConfig()
        : { ...publicConfig(), baseUrl: '', model: '', models: [], providers: [], activeProviderId: '', hasKey: false, keyHint: '', configured: false };
      return json(res, 200, {
        config: safeConfig,
        sessions: activeUser && !isBanned(account) ? sessions.filter((session) => session.owner === activeUser).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((session) => ({
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          createdAt: session.createdAt || session.updatedAt,
          pinned: Boolean(session.pinned),
          automationId: session.automationId || (/^自动化：/.test(String(session.title || '')) ? 'legacy-auto' : ''),
          messageCount: (session.messages || []).length,
          toolCount: Object.keys(session.tools || {}).length
        })) : []
      });
    }

    if (req.method === 'POST' && pathname === '/api/providers') {
      const body = await readBody(req);
      if (!config.baseUrl || !config.apiKey || !config.model) {
        return json(res, 400, { error: '请先填好 Base URL、API Key 和模型名称' });
      }
      const list = Array.isArray(config.providers) ? config.providers : [];
      if (list.length >= 5) return json(res, 409, { error: '最多只能保存 5 个 API 配置' });
      const name = String(body.name || config.model || `配置 ${list.length + 1}`).slice(0, 40);
      const item = {
        id: crypto.randomUUID(),
        name,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        createdAt: Date.now()
      };
      config.providers = [...list, item];
      config.models = [...new Set([...(Array.isArray(config.models) ? config.models : []), item.model])].slice(0, 5);
      config.activeProviderId = item.id;
      await saveConfig();
      return json(res, 200, { ok: true, provider: { id: item.id, name: item.name, model: item.model, baseUrl: item.baseUrl } });
    }

    if (req.method === 'POST' && pathname === '/api/providers/active') {
      const body = await readBody(req);
      const list = Array.isArray(config.providers) ? config.providers : [];
      const item = list.find((entry) => entry.id === body.id);
      if (!item) return json(res, 404, { error: '配置不存在' });
      config.baseUrl = item.baseUrl;
      config.apiKey = item.apiKey;
      config.model = item.model;
      config.activeProviderId = item.id;
      await saveConfig();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && pathname === '/api/providers') {
      const id = url.searchParams.get('id');
      const model = url.searchParams.get('model');
      const list = Array.isArray(config.providers) ? config.providers : [];
      const removed = list.find((entry) => (id && entry.id === id) || (model && entry.model === model));
      if (!removed) return json(res, 404, { error: 'API 配置不存在' });
      config.providers = list.filter((entry) => entry.id !== removed.id);
      if (config.activeProviderId === removed.id) config.activeProviderId = '';
      if (!config.providers.some((entry) => entry.model === removed.model)) {
        config.models = (Array.isArray(config.models) ? config.models : []).filter((name) => name !== removed.model);
      }
      if (config.model === removed.model) {
        const next = config.providers[0];
        if (next) {
          config.baseUrl = next.baseUrl;
          config.apiKey = next.apiKey;
          config.model = next.model;
          config.activeProviderId = next.id;
        } else {
          config.baseUrl = '';
          config.apiKey = '';
          config.model = '';
          config.activeProviderId = '';
        }
      }
      await saveConfig();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/config') {
      const body = await readBody(req);
      const next = { ...config };
      if (body.baseUrl !== undefined) next.baseUrl = body.baseUrl ? normalizeBaseUrl(body.baseUrl) : '';
      if (body.model !== undefined) next.model = String(body.model).trim();
      if (body.protocol !== undefined && ['openai','anthropic','gemini'].includes(body.protocol)) next.protocol = body.protocol;
      if (body.thinkingLevel !== undefined && ['low','medium','high','unlimited'].includes(body.thinkingLevel)) next.thinkingLevel = body.thinkingLevel;
      if (body.plan !== undefined && PLANS[body.plan]) next.plan = body.plan;
      if (body.removeModel) {
        const target = String(body.removeModel);
        next.models = (Array.isArray(next.models) ? next.models : []).filter((name) => name !== target);
        if (next.model === target) {
          const provider = (Array.isArray(next.providers) ? next.providers : [])[0];
          next.model = provider?.model || '';
          next.baseUrl = provider?.baseUrl || '';
          next.apiKey = provider?.apiKey || '';
          next.activeProviderId = provider?.id || '';
        }
      }
      if (body.apiKey) next.apiKey = String(body.apiKey).trim();
      if (body.clearKey) next.apiKey = '';
      if (body.temperature !== undefined) next.temperature = Math.min(2, Math.max(0, Number(body.temperature) || 0));
      if (body.maxTokens !== undefined) next.maxTokens = Math.min(1000000, Math.max(64, Number(body.maxTokens) || 8192));
      if (body.systemPrompt !== undefined) next.systemPrompt = String(body.systemPrompt).slice(0, 20000);
      if (body.contextMessages !== undefined) {
        const limit = Number(body.contextMessages);
        next.contextMessages = Number.isFinite(limit) ? Math.max(6, Math.min(200, Math.round(limit))) : 60;
      }
      if (body.compressAfterTokens !== undefined) {
        const limit = Number(body.compressAfterTokens);
        next.compressAfterTokens = Number.isFinite(limit) && limit > 0 ? Math.round(limit) : 100000000;
      }
      if (body.vision && typeof body.vision === 'object') {
        next.vision = {
          baseUrl: String(body.vision.baseUrl || ''),
          apiKey: String(body.vision.apiKey || next.vision?.apiKey || ''),
          model: String(body.vision.model || '')
        };
      }
      if (body.transcribe && typeof body.transcribe === 'object') {
        next.transcribe = {
          baseUrl: String(body.transcribe.baseUrl || ''),
          apiKey: String(body.transcribe.apiKey || next.transcribe?.apiKey || ''),
          model: String(body.transcribe.model || '')
        };
      }
      if (body.browsers && typeof body.browsers === 'object') {
        next.browsers = {
          chrome: body.browsers.chrome !== false,
          edge: body.browsers.edge !== false
        };
      }
      if (body.disabledTools !== undefined) {
        const list = Array.isArray(body.disabledTools) ? body.disabledTools : [];
        next.disabledTools = [...new Set(list.filter((name) => typeof name === 'string').map((name) => name.slice(0, 120)))].slice(0, 200);
      }
      if (body.localModelEnabled !== undefined) {
        const username = currentUsername(req);
        if (!username || account?.role !== 'admin') {
          return json(res, 403, { error: '只有管理员可以切换本地内置模型' });
        }
        const available = await probeLocalModel(true);
        if (body.localModelEnabled && !available) {
          return json(res, 409, { error: '本地模型服务未就绪，请先启动 llama-server' });
        }
        next.localModelEnabled = Boolean(body.localModelEnabled);
      }
      if (body.searchEnabled !== undefined) next.searchEnabled = Boolean(body.searchEnabled);
      if (body.thinkingLimit !== undefined) {
        const limit = Number(body.thinkingLimit);
        next.thinkingLimit = Number.isFinite(limit) && limit > 0 ? Math.min(200000, Math.round(limit)) : 0;
      }
      if (body.permission !== undefined) {
        next.permission = ['forbidden', 'confirm', 'open'].includes(body.permission) ? body.permission : 'confirm';
      }
      if (body.workspace) {
        const resolved = path.resolve(String(body.workspace));
        await fs.mkdir(resolved, { recursive: true });
        next.workspace = resolved;
      }
      config = next;
      await saveConfig();
      if (body.plan !== undefined && PLANS[body.plan] && account && account.plan !== next.plan) {
        account.plan = next.plan;
        await saveAccount();
        const record = users.find((item) => item.username === currentUsername(req));
        if (record) { record.plan = next.plan; await saveUsers(); }
      }
      return json(res, 200, { config: publicConfig() });
    }

    if (req.method === 'GET' && pathname === '/api/tools') {
      return json(res, 200, { groups: toolCatalog(), searchEnabled: Boolean(config.searchEnabled) });
    }

    if (req.method === 'GET' && pathname === '/api/audit') {
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
      return json(res, 200, { entries: auditLog.slice(-limit).reverse() });
    }

    if (req.method === 'POST' && pathname === '/api/share') {
      const body = await readBody(req);
      const session = sessions.find((item) => item.id === body.sessionId);
      if (!session) return json(res, 404, { error: '对话不存在' });
      if (!canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      shares[token] = { sessionId: session.id, createdAt: Date.now() };
      await saveShares();
      return json(res, 200, { token, url: `${req.headers.origin || `http://127.0.0.1:${PORT}`}/share/${token}` });
    }

    if (pathname === '/api/automations' && req.method === 'GET') {
      const owner = currentUsername(req);
      if (!owner) return json(res, 401, { error: '请先登录' });
      const now = Date.now();
      const tasks = automations.filter((task) => task.owner === owner).map((task) => ({ ...task, running: automationRunning.has(task.id), nextRunAt: task.enabled ? automationNextRun(task, now) : null, summary: automationSummary(task) }));
      const runs = automationRuns.filter((run) => run.owner === owner).slice(0, 50);
      return json(res, 200, { tasks, runs });
    }
    if (pathname === '/api/automations' && req.method === 'POST') {
      const owner = currentUsername(req);
      if (!owner) return json(res, 401, { error: '请先登录' });
      const body = await readBody(req);
      const existing = body.id ? automations.find((task) => task.id === body.id && task.owner === owner) : null;
      if (body.id && !existing) return json(res, 404, { error: '任务不存在' });
      const title = String(body.title || existing?.title || '').trim().slice(0, 120);
      const prompt = String(body.prompt || existing?.prompt || '').trim().slice(0, 20000);
      if (!title || !prompt) return json(res, 400, { error: '请填写任务名称和执行内容' });
      const type = ['once', 'interval', 'daily', 'weekly', 'manual'].includes(body.type) ? body.type : (existing?.type || 'once');
      const task = existing || { id: crypto.randomUUID(), owner, createdAt: Date.now(), runCount: 0 };
      task.title = title; task.prompt = prompt; task.type = type; task.updatedAt = Date.now();
      task.enabled = body.enabled === undefined ? (existing?.enabled ?? true) : Boolean(body.enabled);
      task.access = body.access === 'confirm' ? 'confirm' : existing?.access === 'confirm' ? 'confirm' : 'open';
      task.runAt = body.runAt ? Number(body.runAt) : existing?.runAt || 0;
      task.intervalMinutes = Math.max(1, Number(body.intervalMinutes) || existing?.intervalMinutes || 60);
      task.time = /^\d{2}:\d{2}$/.test(String(body.time || '')) ? String(body.time) : existing?.time || '09:00';
      task.weekdays = Array.isArray(body.weekdays) ? [...new Set(body.weekdays.map(Number).filter((n) => n >= 0 && n <= 6))] : existing?.weekdays || [1, 2, 3, 4, 5];
      if (type === 'once' && (!task.runAt || Number(task.runAt) <= Date.now())) return json(res, 400, { error: '执行时间已经过去，请重新选择' });
      task.nextRunAt = automationNextRun(task, Date.now());
      if (!existing) automations.unshift(task);
      await saveAutomations();
      return json(res, 200, { task: { ...task, summary: automationSummary(task) } });
    }
    if (pathname === '/api/automations' && req.method === 'DELETE') {
      const owner = currentUsername(req);
      if (!owner) return json(res, 401, { error: '请先登录' });
      const id = url.searchParams.get('id');
      const before = automations.length;
      if (automationControllers.has(id)) { try { automationControllers.get(id).abort(); } catch { } }
      automations = automations.filter((task) => !(task.id === id && task.owner === owner));
      if (automations.length === before) return json(res, 404, { error: '任务不存在' });
      automationRuns = automationRuns.filter((run) => !(run.taskId === id && run.owner === owner));
      const removedSessions = sessions.filter((session) => session.owner === owner && session.automationId === id).map((session) => session.id);
      for (const sid of removedSessions) {
        if (activeRuns.has(sid)) { const runId = activeRuns.get(sid); try { runs.get(runId)?.controller.abort(); } catch { } activeRuns.delete(sid); }
        if (!deletedState.ids.includes(sid)) deletedState.ids.push(sid);
      }
      sessions = sessions.filter((session) => !(session.owner === owner && session.automationId === id));
      saveDeletedNow();
      saveSessionsSoon();
      await saveAutomations();
      return json(res, 200, { ok: true, removedSessions });
    }
    if (pathname === '/api/automation-runs' && req.method === 'DELETE') {
      const owner = currentUsername(req);
      if (!owner) return json(res, 401, { error: '请先登录' });
      const id = url.searchParams.get('id');
      const before = automationRuns.length;
      automationRuns = automationRuns.filter((run) => !(run.id === id && run.owner === owner));
      if (automationRuns.length === before) return json(res, 404, { error: '记录不存在' });
      await saveAutomations();
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/automations/stop' && req.method === 'POST') {
      const owner = currentUsername(req);
      if (!owner) return json(res, 401, { error: '请先登录' });
      const body = await readBody(req);
      const task = automations.find((item) => item.id === body.id && item.owner === owner)
        || automations.find((item) => body.sessionId && item.lastSessionId === body.sessionId && item.owner === owner);
      if (!task) return json(res, 404, { error: '任务不存在' });
      const controller = automationControllers.get(task.id);
      if (controller) controller.abort();
      return json(res, 200, { ok: Boolean(controller) });
    }
    if (pathname === '/api/automation-sessions' && req.method === 'DELETE') {
      const owner = currentUsername(req);
      if (!owner) return json(res, 401, { error: '请先登录' });
      const removed = sessions.filter((session) => session.owner === owner && session.automationId).map((session) => session.id);
      for (const sid of removed) {
        if (activeRuns.has(sid)) { const runId = activeRuns.get(sid); try { runs.get(runId)?.controller.abort(); } catch { } activeRuns.delete(sid); }
        if (!deletedState.ids.includes(sid)) deletedState.ids.push(sid);
      }
      sessions = sessions.filter((session) => !(session.owner === owner && session.automationId));
      saveDeletedNow();
      saveSessionsSoon();
      return json(res, 200, { ok: true, removed });
    }
    if (pathname === '/api/automations/run' && req.method === 'POST') {
      const owner = currentUsername(req);
      if (!owner) return json(res, 401, { error: '请先登录' });
      const body = await readBody(req);
      const task = automations.find((item) => item.id === body.id && item.owner === owner);
      if (!task) return json(res, 404, { error: '任务不存在' });
      const session = await createAutomationSession(task);
      runAutomation(task, 'manual', session).catch(() => {});
      return json(res, 200, { ok: true, sessionId: session.id });
    }
    if (pathname === '/api/automations/toggle' && req.method === 'POST') {
      const owner = currentUsername(req);
      if (!owner) return json(res, 401, { error: '请先登录' });
      const body = await readBody(req);
      const task = automations.find((item) => item.id === body.id && item.owner === owner);
      if (!task) return json(res, 404, { error: '任务不存在' });
      task.enabled = Boolean(body.enabled);
      task.nextRunAt = automationNextRun(task, Date.now());
      task.updatedAt = Date.now();
      await saveAutomations();
      return json(res, 200, { ok: true, task });
    }

    if (req.method === 'POST' && pathname === '/api/tasks') {
    const running = [...backgroundTasks.values()].filter((task) => task.status === 'running').length;
    const limit = (PLANS[config.plan || 'free'] || PLANS.free).concurrent;
    if (running >= limit) {
      return json(res, 429, { error: `当前套餐最多同时运行 ${limit} 个任务，请升级后重试` });
    }
      const body = await readBody(req);
      try {
        const task = await startBackgroundTask({ sessionId: body.sessionId, message: String(body.message || '') });
        return json(res, 200, { task: { id: task.id, status: task.status, startedAt: task.startedAt } });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    if (req.method === 'GET' && pathname === '/api/tasks') {
      const id = url.searchParams.get('id');
      if (id) {
        const task = backgroundTasks.get(id);
        if (!task) return json(res, 404, { error: '任务不存在' });
        return json(res, 200, { task: { id: task.id, status: task.status, output: task.output.slice(-6000), startedAt: task.startedAt, finishedAt: task.finishedAt, error: task.error } });
      }
      const list = [...backgroundTasks.values()].map((task) => ({ id: task.id, sessionId: task.sessionId, status: task.status, startedAt: task.startedAt, finishedAt: task.finishedAt }));
      return json(res, 200, { tasks: list.slice(-50).reverse() });
    }

    if (req.method === 'GET' && pathname === '/api/mcp') {
      await ensureMcpClients().catch(() => {});
      const servers = (Array.isArray(config.mcpServers) ? config.mcpServers : []).map((item) => {
        const client = mcpClients.get(item.name);
        return {
          name: item.name,
          command: item.command,
          args: item.args || [],
          enabled: item.enabled !== false,
          status: client?.status || 'idle',
          error: client?.error || '',
          tools: (client?.tools || []).map((tool) => ({ name: tool.name, description: tool.description || '' }))
        };
      });
      return json(res, 200, { servers });
    }

    if (req.method === 'POST' && pathname === '/api/mcp') {
      const body = await readBody(req);
      const list = Array.isArray(body.servers) ? body.servers : [];
      const cleaned = list
        .filter((item) => item && typeof item.name === 'string' && typeof item.command === 'string')
        .slice(0, 20)
        .map((item) => ({
          name: String(item.name).trim().slice(0, 40),
          command: String(item.command).trim(),
          args: Array.isArray(item.args) ? item.args.map(String).slice(0, 20) : [],
          env: item.env && typeof item.env === 'object' ? item.env : {},
          enabled: item.enabled !== false
        }))
        .filter((item) => item.name && item.command);
      config.mcpServers = cleaned;
      await saveConfig();
      for (const client of mcpClients.values()) client.close();
      mcpClients.clear();
      await ensureMcpClients().catch(() => {});
      return json(res, 200, { ok: true, servers: config.mcpServers });
    }

    if (req.method === 'POST' && pathname === '/api/mcp/test') {
      const body = await readBody(req);
      if (!body.command) return json(res, 400, { error: '缺少启动命令' });
      const client = new McpClient({ name: 'test', command: String(body.command), args: Array.isArray(body.args) ? body.args.map(String) : [] });
      try {
        const tools = await client.start();
        return json(res, 200, {
          ok: true,
          tools: tools.map((tool) => ({ name: tool.name, description: tool.description || '' }))
        });
      } catch (error) {
        return json(res, 200, { ok: false, error: error.message });
      } finally {
        client.close();
      }
    }

    if (req.method === 'GET' && pathname === '/api/local-model') {
      const available = await probeLocalModel(true);
      return json(res, 200, {
        url: LOCAL_MODEL_URL, name: LOCAL_MODEL_NAME, label: LOCAL_MODEL_LABEL,
        available, enabled: Boolean(config.localModelEnabled)
      });
    }

    if (req.method === 'POST' && pathname === '/api/models') {
      const body = await readBody(req);
      const baseUrl = body.baseUrl ? normalizeBaseUrl(body.baseUrl) : config.baseUrl;
      const apiKey = body.apiKey || config.apiKey;
      if (!baseUrl || !apiKey) return json(res, 400, { error: '需要 Base URL 与 API Key' });
      try {
        const models = await listProviderModels({ baseUrl, apiKey });
        config.models = models.slice(0, 300);
        if (baseUrl === config.baseUrl) await saveConfig();
        return json(res, 200, { models });
      } catch (error) {
        return json(res, 502, { error: error.message });
      }
    }

    if (req.method === 'GET' && pathname === '/api/sessions') {
      const username = currentUsername(req);
      if (!username) return json(res, 401, { error: '请先登录' });
      return json(res, 200, { sessions: sessions.filter((item) => item.owner === username) });
    }

    if (req.method === 'POST' && pathname === '/api/sessions') {
      const session = { id: crypto.randomUUID(), owner: account?.username || '', title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
      await ensureSessionWorkspace(session);
      sessions.unshift(session);
      saveSessionsSoon();
      return json(res, 200, { session });
    }

    if (req.method === 'GET' && pathname === '/api/session') {
      const id = url.searchParams.get('id');
      const session = sessions.find((item) => item.id === id);
      if (!session) return json(res, 404, { error: '对话不存在' });
      if (!canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      return json(res, 200, { session });
    }

    if (req.method === 'DELETE' && pathname === '/api/sessions') {
      const username = currentUsername(req);
      if (!username) return json(res, 401, { error: '请先登录' });
      const removed = sessions.filter((item) => item.owner === username && !item.automationId);
      for (const session of removed) if (activeRuns.has(session.id)) { const runId = activeRuns.get(session.id); try { runs.get(runId)?.controller.abort(); } catch { } activeRuns.delete(session.id); }
      for (const session of removed) if (!deletedState.ids.includes(session.id)) deletedState.ids.push(session.id);
      sessions = sessions.filter((item) => !(item.owner === username && !item.automationId));
      saveDeletedNow();
      saveSessionsSoon();
      return json(res, 200, { ok: true, preserved: sessions.filter((item) => item.automationId).length });
    }

    if (req.method === 'DELETE' && pathname === '/api/session') {
      const id = url.searchParams.get('id');
      const session = sessions.find((item) => item.id === id);
      if (!session) return json(res, 404, { error: '对话不存在' });
      if (!canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      const runId = activeRuns.get(id);
      if (runId) { try { runs.get(runId)?.controller.abort(); } catch { } activeRuns.delete(id); }
      if (id && !deletedState.ids.includes(id)) deletedState.ids.push(id);
      sessions = sessions.filter((item) => item.id !== id);
      saveDeletedNow();
      saveSessionsSoon();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/session/state') {
      const body = await readBody(req);
      const session = sessions.find((item) => item.id === body.id);
      if (!session) return json(res, 404, { error: '会话不存在' });
      if (!canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      if (body.openFile !== undefined) session.openFile = String(body.openFile || '');
      if (body.pane !== undefined) session.pane = String(body.pane || '');
      saveSessionsNow();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/session/pin') {
      const body = await readBody(req);
      const session = sessions.find((item) => item.id === body.id);
      if (!session) return json(res, 404, { error: '对话不存在' });
      if (!canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      session.pinned = Boolean(body.pinned);
      saveSessionsSoon();
      return json(res, 200, { ok: true, pinned: session.pinned });
    }

    if (req.method === 'GET' && pathname === '/api/session/export') {
      const id = url.searchParams.get('id');
      const session = sessions.find((item) => item.id === id);
      if (!session) return json(res, 404, { error: '对话不存在' });
      if (!canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      const lines = [`# ${session.title || '对话'}`, ''];
      for (const message of session.messages || []) {
        if (message.role === 'user') lines.push(`## 你`, '', String(message.content || ''), '');
        else if (message.role === 'assistant' && message.content) lines.push(`## Nalo Code`, '', String(message.content), '');
      }
      const name = encodeURIComponent(`${(session.title || '对话').slice(0, 40)}.md`);
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${name}`
      });
      return res.end(lines.join('\n'));
    }

    if (req.method === 'POST' && pathname === '/api/session/rename') {
      const body = await readBody(req);
      const session = sessions.find((item) => item.id === body.id);
      if (!session) return json(res, 404, { error: '对话不存在' });
      if (!canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      session.title = String(body.title || '未命名').slice(0, 80);
      saveSessionsSoon();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await readBody(req);
      const session = body.sessionId
        ? sessions.find((item) => item.id === body.sessionId)
        : { id: crypto.randomUUID(), owner: currentUsername(req) || '', title: '新对话', messages: [], createdAt: Date.now() };
      if (!session) return json(res, 404, { error: '对话不存在' });
      if (!canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      if (!sessions.includes(session)) sessions.unshift(session);
      const localReady = config.localModelEnabled && await probeLocalModel();
      if (config.localModelEnabled && !localReady) {
        return json(res, 409, { error: '本地模型未就绪：llama-server 没有响应，请稍后再试，或在设置里关闭本地内置模型' });
      }
      if (!localReady && (!config.baseUrl || !config.apiKey || !config.model)) {
        return json(res, 400, { error: '请先配置 Base URL、API Key 与模型名称' });
      }
      const text = String(body.message || '').trim();
      if (!text) return json(res, 400, { error: '消息为空' });

      if (activeRuns.has(session.id)) {
        const list = queuedChats.get(session.id) || [];
        list.push(text);
        queuedChats.set(session.id, list);
        return json(res, 200, { queued: true });
      }

      session.messages.push({ role: 'user', content: text });
      session.updatedAt = Date.now();
      if (session.title === '新对话') session.title = text.slice(0, 32);
      saveSessionsSoon();

      const runId = crypto.randomUUID();
      const controller = new AbortController();
      runs.set(runId, { controller });
      const emit = sse(res);
      activeRuns.set(session.id, runId);
      emit('start', { runId, sessionId: session.id });

      const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
      try {
        const automationTask = session.automationId ? automations.find((item) => item.id === session.automationId) : null;
        await runAgent({ session, runId, emit, signal: controller.signal, autoApprove: automationTask ? automationTask.access !== 'confirm' : false, automationMode: Boolean(automationTask) });
      } catch (error) {
        const message = error?.name === 'AbortError' ? '已停止' : error.message;
        emit('error', { message });
      } finally {
        clearInterval(keepAlive);
        runs.delete(runId);
        if (activeRuns.get(session.id) === runId) activeRuns.delete(session.id);
        saveSessionsNow();
        res.end();
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/session/flush') {
      saveSessionsNow();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/answer') {
      const body = await readBody(req);
      const resolve = pendingQuestions.get(body.id);
      if (resolve) resolve(String(body.answer ?? '').slice(0, 4000));
      return json(res, 200, { ok: Boolean(resolve) });
    }

    if (req.method === 'POST' && pathname === '/api/stop') {
      const body = await readBody(req);
      const runId = body.runId || (body.sessionId ? activeRuns.get(body.sessionId) : null);
      const run = runs.get(runId);
      if (run) run.controller.abort();
      if (body.sessionId) activeRuns.delete(body.sessionId);
      for (const [, resolve] of pendingQuestions) resolve('用户中止');
      pendingQuestions.clear();
      saveSessionsNow();
      return json(res, 200, { ok: Boolean(run) });
    }

    if (req.method === 'GET' && pathname === '/api/tree') {
      const relative = url.searchParams.get('path') || '.';
      const sessionId = url.searchParams.get('session');
      const session = sessionId ? sessions.find((item) => item.id === sessionId) : null;
      if (sessionId && !canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      const workspace = session ? await ensureSessionWorkspace(session) : (sessionId ? null : config.workspace);
      if (!workspace) return json(res, 404, { error: '对话不存在' });
      const target = resolveInside(workspace, relative);
      const entries = await fs.readdir(target, { withFileTypes: true });
      const rows = [];
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(target, entry.name);
        const stat = entry.isFile() ? await fs.stat(full).catch(() => ({ size: 0 })) : null;
        rows.push({
          name: entry.name,
          dir: entry.isDirectory(),
          size: stat ? stat.size : 0,
          mtime: stat ? stat.mtimeMs : 0,
          path: path.relative(path.resolve(workspace), full).replace(/\\/g, '/')
        });
      }
      rows.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      return json(res, 200, { path: relative, entries: rows, workspace });
    }

    if (req.method === 'GET' && pathname === '/api/render') {
      const sessionId = url.searchParams.get('session');
      const session = sessionId ? sessions.find((item) => item.id === sessionId) : null;
      if (sessionId && !canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      const workspace = session ? await ensureSessionWorkspace(session) : config.workspace;
      let target;
      try { target = resolveInside(workspace, url.searchParams.get('path')); }
      catch (error) { return json(res, 400, { error: error.message }); }
      const stat = await fs.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) return json(res, 404, { error: '文件不存在' });
      const ext = path.extname(target).toLowerCase();
      let pdf = target;
      if (['.pptx', '.ppt', '.docx', '.doc', '.xlsx', '.xls'].includes(ext)) {
        try {
          const key = crypto.createHash('sha1').update(target + ':' + stat.size + ':' + stat.mtimeMs).digest('hex');
          const dir = path.join(DATA, 'previews');
          await fs.mkdir(dir, { recursive: true });
          pdf = path.join(dir, key + '.pdf');
          if (!existsSync(pdf)) {
            const script = path.join(ROOT, 'tools', 'convert_office.ps1');
            await new Promise((resolve, reject) => {
              const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-InputFile', target, '-OutputFile', pdf], { windowsHide: true });
              let err = '';
              const timer = setTimeout(() => { try { child.kill(); } catch { } reject(new Error('转换超时')); }, 120000);
              child.stderr.on('data', (chunk) => { err += chunk.toString(); });
              child.on('error', (error) => { clearTimeout(timer); reject(error); });
              child.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0 && existsSync(pdf)) resolve();
                else reject(new Error(err.trim() || `转换失败（${code}）`));
              });
            });
          }
        } catch (error) {
          return json(res, 500, { error: `无法生成文档预览：${error.message}` });
        }
      } else if (ext !== '.pdf') {
        return json(res, 400, { error: '该文件不支持文档预览' });
      }
      const data = await fs.readFile(pdf);
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': data.length, 'cache-control': 'no-store' });
      return res.end(data);
    }

    if (req.method === 'GET' && pathname === '/api/file-stat') {
      const sessionId = url.searchParams.get('session');
      const session = sessionId ? sessions.find((item) => item.id === sessionId) : null;
      if (sessionId && !canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      const workspace = session ? await ensureSessionWorkspace(session) : config.workspace;
      let target;
      try { target = resolveInside(workspace, url.searchParams.get('path')); }
      catch (error) { return json(res, 400, { error: error.message }); }
      const stat = await fs.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) return json(res, 404, { error: '文件不存在' });
      return json(res, 200, { size: stat.size, mtime: stat.mtimeMs });
    }

    if (req.method === 'GET' && pathname === '/api/file') {
      const sessionId = url.searchParams.get('session');
      const session = sessionId ? sessions.find((item) => item.id === sessionId) : null;
      if (sessionId && !canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      const workspace = session ? await ensureSessionWorkspace(session) : config.workspace;
      const target = resolveInside(workspace, url.searchParams.get('path'));
      const stat = await fs.stat(target);
      if (!stat.isFile()) return json(res, 400, { error: '不是文件' });
      if (stat.size > MAX_FILE_BYTES) return json(res, 413, { error: '文件过大，仅支持 400 KB 以内的文本' });
      const content = await fs.readFile(target, 'utf8');
      return json(res, 200, { path: url.searchParams.get('path'), content, size: stat.size });
    }

    if (req.method === 'GET' && pathname.startsWith('/preview/')) {
      const token = pathname.slice('/preview/'.length);
      const item = previews.get(token);
      if (!item || item.exp < Date.now()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('预览已过期');
      }
      try {
        const data = await fs.readFile(item.path);
        const ext = path.extname(item.path).toLowerCase();
        const types = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json; charset=utf-8' };
        res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(data);
      } catch {
        res.writeHead(404); return res.end('not found');
      }
    }

    if (req.method === 'GET' && pathname === '/api/raw') {
      const sessionId = url.searchParams.get('session');
      const session = sessionId ? sessions.find((item) => item.id === sessionId) : null;
      if (sessionId && !canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      const workspace = session ? await ensureSessionWorkspace(session) : config.workspace;
      const target = resolveInside(workspace, url.searchParams.get('path'));
      const stat = await fs.stat(target);
      if (!stat.isFile()) return json(res, 400, { error: '不是文件' });
      const ext = path.extname(target).toLowerCase();
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
      const data = await fs.readFile(target);
      const headers = { 'content-type': types[ext] || 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-store' };
      if (url.searchParams.get('download')) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`;
      res.writeHead(200, headers);
      return res.end(data);
    }

    if (req.method === 'POST' && pathname === '/api/open') {
      const body = await readBody(req);
      const session = body.session ? sessions.find((item) => item.id === body.session) : null;
      const workspace = session ? await ensureSessionWorkspace(session) : config.workspace;
      const target = resolveInside(workspace, body.path);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) return json(res, 404, { error: '文件不存在' });
      spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/file') {
      const body = await readBody(req);
      const session = body.session ? sessions.find((item) => item.id === body.session) : null;
      const workspace = session ? await ensureSessionWorkspace(session) : config.workspace;
      const target = resolveInside(workspace, body.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(body.content ?? ''), 'utf8');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && pathname === '/api/file') {
      const sessionId = url.searchParams.get('session');
      const session = sessionId ? sessions.find((item) => item.id === sessionId) : null;
      if (sessionId && !canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      const workspace = session ? await ensureSessionWorkspace(session) : config.workspace;
      const relative = url.searchParams.get('path') || '';
      if (!relative) return json(res, 400, { error: '缺少路径' });
      const target = resolveInside(workspace, relative);
      const stat = await fs.lstat(target).catch(() => null);
      if (!stat) return json(res, 404, { error: '文件不存在' });
      if (stat.isDirectory()) {
        const entries = await fs.readdir(target);
        if (entries.length) return json(res, 400, { error: '目录不为空，先清空再删除' });
        await fs.rmdir(target);
      } else {
        await fs.unlink(target);
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/download') {
      const sessionId = url.searchParams.get('session');
      const session = sessionId ? sessions.find((item) => item.id === sessionId) : null;
      if (sessionId && !canAccessSession(req, session)) return json(res, 403, { error: '无权访问这个对话' });
      const workspace = session ? await ensureSessionWorkspace(session) : config.workspace;
      const relative = url.searchParams.get('path') || '';
      const target = resolveInside(workspace, relative);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) return json(res, 404, { error: '文件不存在' });
      const data = await fs.readFile(target);
      const name = encodeURIComponent(path.basename(target));
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${name}`,
        'content-length': data.length
      });
      return res.end(data);
    }

    if (req.method === 'POST' && pathname === '/api/open-workspace') {
      return json(res, 200, { workspace: config.workspace });
    }

    if (req.method === 'POST' && pathname === '/api/email/test') {
      const body = await readBody(req);
      const to = String(body.to || '').trim();
      if (!to) return json(res, 400, { error: '缺少收件地址' });
      if (!config.smtp?.host) return json(res, 400, { error: 'SMTP 未配置' });
      try {
        await sendSmtpMail({
          host: config.smtp.host, port: config.smtp.port || 465,
          user: config.smtp.user, pass: config.smtp.pass,
          from: config.smtp.from || config.smtp.user, name: config.smtp.name || 'Nalo Code',
          to, subject: 'Nalo Code 测试邮件', text: '这是一封来自 Nalo Code 的测试邮件。'
        });
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/email/code') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: '邮箱格式不正确' });
      if (!verifyCaptcha(body.captchaId, body.captchaAnswer)) return json(res, 400, { error: '人机验证不正确' });
      try {
        return json(res, 200, { ok: true, ...(await sendEmailCode(email)) });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }

    if (req.method === 'GET' && pathname === '/api/captcha') {
      return json(res, 200, createCaptcha());
    }

    if (req.method === 'GET' && pathname === '/api/app') {
      const username = currentUsername(req);
      const banned = Boolean(username) && isBanned(account);
      return json(res, 200, {
        name: 'Nalo Code',
        version: APP_VERSION,
        plan: account?.plan || config.plan || 'free',
        planLimits: PLANS[account?.plan || config.plan || 'free'] || PLANS.free,
        protocol: config.protocol || 'openai',
    thinkingLevel: config.thinkingLevel || 'medium',
        vendor: '淬序工坊',
        hasAccount: Boolean(account),
        authenticated: Boolean(username) && !banned,
        banned,
        banMessage: banned ? banMessage(account) : '',
        username: username || '',
        role: username ? (account?.role || null) : null,
        maintenance: maintenanceState,
        localModel: {
          url: LOCAL_MODEL_URL,
          name: LOCAL_MODEL_NAME,
          label: LOCAL_MODEL_LABEL,
          enabled: Boolean(config.localModelEnabled),
          available: await probeLocalModel()
        },
        profile: username ? publicProfile() : null,
        usage: username ? usage : null
      });
    }

    if (req.method === 'POST' && pathname === '/api/account/register') {
      const body = await readBody(req);
      const username = String(body.username || '').trim().slice(0, 40);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (username.length < 2) return json(res, 400, { error: '用户名至少 2 个字符' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: '邮箱格式不正确' });
      if (!verifyEmailCode(email, body.code)) return json(res, 400, { error: '邮箱验证码不正确' });
      if (password.length < 6) return json(res, 400, { error: '密码至少 6 位' });
      if (users.some((item) => item.username.toLowerCase() === username.toLowerCase())) return json(res, 409, { error: '用户名已被注册' });
      if (users.some((item) => String(item.email || '').toLowerCase() === email)) return json(res, 409, { error: '邮箱已被注册' });
      const salt = crypto.randomBytes(16).toString('hex');
      const user = { id: crypto.randomUUID(), username, email, salt, hash: scryptHash(password, salt), role: 'user', plan: 'free', createdAt: Date.now(), lastLogin: 0, bannedUntil: 0, banPermanent: false };
      users.push(user);
      profiles[username] = { ...defaultProfile(username), nickname: username };
      userConfigs[username] = { ...DEFAULT_CONFIG };
      userUsages[username] = { promptTokens: 0, completionTokens: 0, updatedAt: 0, days: {} };
      await saveUserConfigs();
      await saveUserUsages();
      await fs.writeFile(PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf8');
      await saveUsers();
      return json(res, 200, { ok: true, user: { username, email } });
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const user = email
        ? users.find((item) => String(item.email || '').toLowerCase() === email)
        : users.find((item) => item.username === username);
      if (!user) return json(res, 401, { error: email ? '邮箱或密码不正确' : '用户名或密码不正确' });
      if (scryptHash(password, user.salt) !== user.hash) return json(res, 401, { error: email ? '邮箱或密码不正确' : '用户名或密码不正确' });
      if (isBanned(user)) return json(res, 403, { error: banMessage(user), banned: true, bannedUntil: user.bannedUntil || 0, banPermanent: Boolean(user.banPermanent) });
      if (maintenanceState.enabled && user.role !== 'admin') return json(res, 503, { error: maintenanceState.message || '系统维护中', maintenance: true, message: maintenanceState.message || '系统维护中' });
      user.lastLogin = Date.now();
      account = user;
      applyProfile(user.username);
      applyUserConfig(user.username);
      applyUserUsage(user.username);
      await saveUsers();
      await saveAccount();
      grantAuth(res, Boolean(body.remember));
      const admins = String(process.env.ADMIN_USERS || 'xiaoluo').split(',').map((item) => item.trim()).filter(Boolean);
      adminBypass = admins.includes(user.username) || user.role === 'admin';
      if (adminBypass) clearMaintenance();
      return json(res, 200, { ok: true, profile: publicProfile() });
    }

    if (req.method === 'POST' && pathname === '/api/account/email') {
      const body = await readBody(req);
      const username = currentUsername(req);
      if (!username || !account) return json(res, 401, { error: '请先登录' });
      const newEmail = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return json(res, 400, { error: '邮箱格式不正确' });
      if (!verifyEmailCode(account.email, body.oldCode)) return json(res, 400, { error: '原邮箱验证码不正确' });
      if (!verifyEmailCode(newEmail, body.newCode)) return json(res, 400, { error: '新邮箱验证码不正确' });
      if (users.some((item) => item.username !== username && String(item.email || '').toLowerCase() === newEmail)) return json(res, 409, { error: '邮箱已被其他账号使用' });
      account.email = newEmail;
      const user = users.find((item) => item.username === username);
      if (user) user.email = newEmail;
      await saveAccount();
      await saveUsers();
      return json(res, 200, { ok: true, email: newEmail });
    }

    if (req.method === 'GET' && pathname === '/api/announcements') {
      if (!currentUsername(req)) return json(res, 401, { error: '请先登录' });
      return json(res, 200, { announcements: announcements.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) });
    }

    if (req.method === 'DELETE' && pathname === '/api/admin/announcements') {
      if (!currentUsername(req) || account?.role !== 'admin') return json(res, 403, { error: '仅管理员可用' });
      const id = url.searchParams.get('id');
      const before = announcements.length;
      announcements = announcements.filter((item) => item.id !== id);
      if (announcements.length === before) return json(res, 404, { error: '公告不存在' });
      await fs.writeFile(ANNOUNCE_FILE, JSON.stringify(announcements, null, 2), 'utf8');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/admin/announcements') {
      if (!currentUsername(req) || account?.role !== 'admin') return json(res, 403, { error: '仅管理员可用' });
      const body = await readBody(req);
      const title = String(body.title || '').trim().slice(0, 120);
      const content = String(body.content || '').trim().slice(0, 5000);
      if (!title) return json(res, 400, { error: '请输入公告标题' });
      if (!content) return json(res, 400, { error: '请输入公告内容' });
      const item = { id: crypto.randomUUID(), title, content, author: account.username, createdAt: Date.now() };
      announcements.unshift(item);
      await fs.writeFile(ANNOUNCE_FILE, JSON.stringify(announcements, null, 2), 'utf8');
      return json(res, 200, { ok: true, announcement: item });
    }

    if (req.method === 'POST' && pathname === '/api/feedback') {
      const body = await readBody(req);
      const username = currentUsername(req) || '未登录';
      const email = account?.email || '';
      await fs.appendFile(FEEDBACK_FILE, JSON.stringify({ id: crypto.randomUUID(), username, email, message: String(body.message || '').slice(0, 2000), createdAt: Date.now() }) + '\n', 'utf8');
      return json(res, 200, { ok: true, adminEmail: 'gh37660809@gmail.com' });
    }

    if (req.method === 'GET' && pathname === '/api/admin/feedback') {
      if (!currentUsername(req) || account?.role !== 'admin') return json(res, 403, { error: '仅管理员可用' });
      let list = [];
      try {
        const raw = await fs.readFile(FEEDBACK_FILE, 'utf8');
        list = raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      } catch { list = []; }
      return json(res, 200, { feedback: list.slice(-300).reverse() });
    }

    if (req.method === 'GET' && pathname === '/api/admin/users') {
      const username = currentUsername(req);
      if (!username || account?.role !== 'admin') return json(res, 403, { error: '仅管理员可用' });
      return json(res, 200, { users: users.map(({ id, username, email, role, plan, createdAt, lastLogin, bannedUntil, banPermanent }) => ({ id, username, email, role, plan, createdAt, lastLogin, bannedUntil: bannedUntil || 0, banPermanent: Boolean(banPermanent) })) });
    }

    if (req.method === 'POST' && pathname === '/api/account/password/verify') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const user = users.find((item) => String(item.email || '').toLowerCase() === email);
      if (!user) return json(res, 404, { error: '该邮箱没有注册账号' });
      if (!verifyEmailCode(email, body.code)) return json(res, 400, { error: '邮箱验证码不正确' });
      const token = crypto.randomUUID();
      passwordResets.set(token, { email, exp: Date.now() + 10 * 60e3 });
      return json(res, 200, { ok: true, resetToken: token, username: user.username });
    }

    if (req.method === 'POST' && pathname === '/api/account/password/reset') {
      const body = await readBody(req);
      const record = passwordResets.get(String(body.resetToken || ''));
      if (!record || record.exp < Date.now()) return json(res, 400, { error: '重置已过期，请重新验证邮箱' });
      const password = String(body.password || '');
      if (password.length < 6) return json(res, 400, { error: '密码至少 6 位' });
      const user = users.find((item) => String(item.email || '').toLowerCase() === record.email);
      if (!user) return json(res, 404, { error: '账号不存在' });
      user.salt = crypto.randomBytes(16).toString('hex');
      user.hash = scryptHash(password, user.salt);
      passwordResets.delete(String(body.resetToken));
      await saveUsers();
      if (account?.username === user.username) {
        account.salt = user.salt;
        account.hash = user.hash;
        await saveAccount();
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/admin/ban') {
      if (!currentUsername(req) || account?.role !== 'admin') return json(res, 403, { error: '仅管理员可用' });
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const user = users.find((item) => item.username === username);
      if (!user) return json(res, 404, { error: '用户不存在' });
      if (user.role === 'admin') return json(res, 400, { error: '不能封禁管理员' });
      if (body.unban) {
        user.banPermanent = false;
        user.bannedUntil = 0;
      } else if (body.permanent) {
        user.banPermanent = true;
        user.bannedUntil = 0;
      } else {
        const until = Number(body.until || 0);
        if (!until || until <= Date.now()) return json(res, 400, { error: '请选择未来的解封日期' });
        user.banPermanent = false;
        user.bannedUntil = until;
      }
      user.banReason = String(body.reason || '').slice(0, 200);
      await saveUsers();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/account/delete') {
      const body = await readBody(req);
      if (!account) return json(res, 401, { error: '请先登录' });
      const email = String(body.email || '').trim().toLowerCase();
      if (email !== String(account.email || '').toLowerCase()) return json(res, 400, { error: '邮箱与当前账号不一致' });
      if (!verifyEmailCode(email, body.code)) return json(res, 400, { error: '邮箱验证码不正确' });
      const username = account.username;
      users = users.filter((item) => item.username !== username);
      delete profiles[username];
      await saveUsers();
      try { await fs.writeFile(PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf8'); } catch { }
      account = null;
      profile = { nickname: '', birthDate: '', gender: 'private', avatar: '', updatedAt: 0 };
      try { await fs.writeFile(ACCOUNT_FILE, 'null', 'utf8'); } catch { }
      authTokens.clear();
      saveAuthTokens();
      res.setHeader('set-cookie', 'flow_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/login/email-code') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const user = users.find((item) => String(item.email || '').toLowerCase() === email);
      if (!user) return json(res, 401, { error: '该邮箱未注册' });
      if (!verifyEmailCode(email, body.code)) return json(res, 400, { error: '邮箱验证码不正确' });
      if (isBanned(user)) return json(res, 403, { error: banMessage(user), banned: true, bannedUntil: user.bannedUntil || 0, banPermanent: Boolean(user.banPermanent) });
      if (maintenanceState.enabled && user.role !== 'admin') return json(res, 503, { error: maintenanceState.message || '系统维护中', maintenance: true, message: maintenanceState.message || '系统维护中' });
      user.lastLogin = Date.now();
      account = user;
      applyProfile(user.username);
      applyUserConfig(user.username);
      applyUserUsage(user.username);
      await saveUsers();
      await saveAccount();
      grantAuth(res, Boolean(body.remember));
      const admins = String(process.env.ADMIN_USERS || 'xiaoluo').split(',').map((item) => item.trim()).filter(Boolean);
      adminBypass = admins.includes(user.username) || user.role === 'admin';
      if (adminBypass) clearMaintenance();
      return json(res, 200, { ok: true, profile: publicProfile() });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      adminBypass = false;
      const token = parseCookies(req).flow_auth;
      if (token) { authTokens.delete(token); saveAuthTokens(); }
      res.setHeader('set-cookie', 'flow_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/account/password') {
      const username = currentUsername(req);
      if (!username || !account) return json(res, 401, { error: '请先登录' });
      const body = await readBody(req);
      if (scryptHash(String(body.current || ''), account.salt) !== account.hash) {
        return json(res, 401, { error: '当前密码不正确' });
      }
      const next = String(body.next || '');
      if (next.length < 6) return json(res, 400, { error: '新密码至少 6 位' });
      account.salt = crypto.randomBytes(16).toString('hex');
      account.hash = scryptHash(next, account.salt);
      const user = users.find((item) => item.username === account.username);
      if (user) { user.salt = account.salt; user.hash = account.hash; await saveUsers(); }
      await saveAccount();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/profile') {
      if (!currentUsername(req)) return json(res, 401, { error: '请先登录' });
      return json(res, 200, { profile: publicProfile(), usage });
    }

    if (req.method === 'POST' && pathname === '/api/profile') {
      if (!currentUsername(req)) return json(res, 401, { error: '请先登录' });
      const body = await readBody(req);
      if (body.nickname !== undefined) profile.nickname = String(body.nickname).trim().slice(0, 40);
      if (body.birthDate !== undefined) profile.birthDate = String(body.birthDate).slice(0, 10);
      if (body.gender !== undefined) {
        const allowed = new Set(['male', 'female', 'nonbinary', 'other', 'private']);
        profile.gender = allowed.has(body.gender) ? body.gender : 'private';
      }
      if (body.avatar !== undefined) {
        const avatar = String(body.avatar);
        if (avatar && !/^data:image\/(png|jpeg|webp);base64,/.test(avatar)) {
          return json(res, 400, { error: '头像格式不支持' });
        }
        if (avatar.length > 400000) return json(res, 413, { error: '头像文件过大' });
        profile.avatar = avatar;
      }
      await saveProfile();
      return json(res, 200, { profile: publicProfile() });
    }

    if (req.method === 'GET' && pathname === '/api/usage') {
      if (!currentUsername(req)) return json(res, 401, { error: '请先登录' });
      return json(res, 200, { usage });
    }

    if (req.method === 'POST' && pathname === '/api/upload') {
      const body = await readBody(req, 12 * 1024 * 1024);
      const raw = String(body.data || '');
      const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
      const buffer = Buffer.from(base64, 'base64');
      if (!buffer.length) return json(res, 400, { error: '文件为空' });
      if (buffer.length > 8 * 1024 * 1024) return json(res, 413, { error: '文件超过 8 MB' });
      const safe = String(body.name || 'file').replace(/[\\/:*?"<>|\s]+/g, '_').slice(-80);
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const session = body.session ? sessions.find((item) => item.id === body.session) : null;
      const workspace = session ? await ensureSessionWorkspace(session) : config.workspace;
      const relative = path.posix.join('uploads', `${stamp}-${safe}`);
      const target = resolveInside(workspace, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, buffer);
      return json(res, 200, {
        ok: true, path: relative, size: buffer.length,
        type: String(body.type || ''), name: safe
      });
    }

    if (req.method === 'POST' && pathname === '/api/feedback') {
      const body = await readBody(req);
      const text = String(body.message || '').trim().slice(0, 4000);
      if (!text) return json(res, 400, { error: '内容为空' });
      await fs.mkdir(DATA, { recursive: true });
      await fs.appendFile(FEEDBACK_FILE, JSON.stringify({
        at: new Date().toISOString(), text, page: String(body.page || '')
      }) + '\n', 'utf8');
      return json(res, 200, { ok: true });
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' });
    return serveStatic(res, pathname);
  } catch (error) {
    if (!res.headersSent) return json(res, 500, { error: error.message });
    try { res.end(); } catch { /* already closed */ }
  }
});

await loadState();
await ensureData();
startAutomationScheduler();
server.listen(PORT, HOST, () => {
  console.log(`Nalo Code listening on http://${HOST}:${PORT}`);
  console.log(`workspace: ${config.workspace}`);
  console.log(config.baseUrl ? `provider: ${config.baseUrl} model ${config.model}` : 'provider: not configured yet');
});
