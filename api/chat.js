const { GoogleGenerativeAI } = require("@google/generative-ai");

// Khởi tạo Gemini với API Key từ biến môi trường Vercel
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Basic demo-only rate limit. This is per Vercel instance, not a production
// replacement for a shared store such as Redis.
const allowedOrigins = new Set([
  "https://safetalk.io.vn",
  "https://www.safetalk.io.vn",
]);
const requestsByIp = new Map();
const COOLDOWN_MS = 30 * 1000;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_HOUR = 20;

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded || "unknown")
    .split(",")[0]
    .trim();
}

function rateLimit(ip) {
  const now = Date.now();

  for (const [key, timestamps] of requestsByIp) {
    const active = timestamps.filter(time => now - time < WINDOW_MS);
    if (active.length) requestsByIp.set(key, active);
    else requestsByIp.delete(key);
  }

  const timestamps = requestsByIp.get(ip) || [];
  const lastRequest = timestamps[timestamps.length - 1];
  if (lastRequest && now - lastRequest < COOLDOWN_MS) {
    return { allowed: false, retryAfter: Math.ceil((COOLDOWN_MS - (now - lastRequest)) / 1000) };
  }
  if (timestamps.length >= MAX_REQUESTS_PER_HOUR) {
    return { allowed: false, retryAfter: Math.ceil((WINDOW_MS - (now - timestamps[0])) / 1000) };
  }

  timestamps.push(now);
  requestsByIp.set(ip, timestamps);
  return { allowed: true };
}

export default async function handler(req, res) {
  // 1. Cấu hình CORS để web của bạn có thể gọi API này
  const origin = req.headers.origin;
  if (!allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "Không cho phép gọi API từ nguồn này" });
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Xử lý kiểm tra quyền truy cập (OPTIONS request)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 2. Chỉ cho phép phương thức POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Chỉ chấp nhận phương thức POST' });
  }

  try {
    const { prompt } = req.body;

    if (typeof prompt === "string" && prompt.length > 600) {
      return res.status(400).json({ error: "Câu hỏi tối đa 600 ký tự" });
    }

    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: 'Thiếu nội dung câu hỏi' });
    }

    // 3. Gọi model Gemini 1.5 Flash (Nhanh và miễn phí tốt)
    const limit = rateLimit(getClientIp(req));
    if (!limit.allowed) {
      res.setHeader("Retry-After", limit.retryAfter);
      return res.status(429).json({
        error: `Bạn gửi quá nhanh. Vui lòng thử lại sau ${limit.retryAfter} giây.`,
      });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });

    // 4. "Luật chơi" cho AI - System Prompt
    const systemInstruction = `Bạn là trợ lý ảo của website SafeTalk Edu (safetalkedu.vn). 
    Bạn là chuyên gia tư vấn giáo dục giới tính cho học sinh THCS - THPT. 
    
    Hãy trả lời dựa trên phạm vi nội dung chuyên môn sau:
    1. Kiến thức tuổi dậy thì: Thay đổi cơ thể nam/nữ, kinh nguyệt, mộng tinh, vệ sinh cá nhân, chăm sóc sức khỏe sinh sản cơ bản.
    2. An toàn cơ thể: Nhận biết vùng riêng tư, quyền được bảo vệ, tôn trọng người khác, quy tắc "5 ngón tay" hoặc "vòng tròn tin cậy", kỹ năng nói "không" và tìm kiếm giúp đỡ.
    3. Phòng tránh xâm hại: Nhận biết hành vi quấy rối/xâm hại, xử lý tình huống nguy hiểm ở trường học/trên mạng, các kênh hỗ trợ khẩn cấp (như Tổng đài 111).
    4. Tình cảm học trò: Phân biệt tình bạn/cảm mến/tình yêu, giao tiếp tôn trọng, ứng xử lành mạnh trên mạng xã hội, tôn trọng cảm xúc và quyết định của người khác.
    5. Giải đáp thắc mắc: Giải thích các hiểu lầm phổ biến ở tuổi vị thành niên.

    LUẬT BẮT BUỘC:
    - Chỉ trả lời các câu hỏi nằm trong phạm vi kiến thức nêu trên.
    - Nếu câu hỏi nằm ngoài phạm vi (pháp luật, chính trị, y tế bệnh lý chuyên sâu, toán học...): 
      Hãy trả lời lịch sự: "SafeTalk Edu xin lỗi, tôi chỉ hỗ trợ các câu hỏi liên quan đến tâm lý, giáo dục giới tính và kỹ năng sống cho tuổi học đường thôi ạ."
    - Giọng văn: Khoa học, nhẹ nhàng, gần gũi và bảo vệ sức khỏe tâm lý người hỏi.
    - Luôn khuyến khích học sinh tìm kiếm sự giúp đỡ từ người lớn tin cậy trong các tình huống nguy hiểm.`;
    
    const result = await model.generateContent(systemInstruction + "\nCâu hỏi: " + prompt);
    const response = await result.response;
    const text = response.text();

    // 5. Trả kết quả về cho website
    res.status(200).json({ answer: text });

  } catch (error) {
    console.error("Lỗi AI:", error);
    res.status(500).json({ error: 'Hệ thống AI đang gặp lỗi' });
  }
}
