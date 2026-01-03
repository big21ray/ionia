#include "stream_muxer.h"
#include "stream_buffer.h"   // 🔥 THIS IS REQUIRED
#include "video_encoder.h"
#include "encoded_audio_packet.h"
#include "ionia_logging.h"


extern "C" {
#include <libavutil/avutil.h>
#include <libavutil/mathematics.h>
#include <libavutil/time.h>
}


// Validate avcC extradata and ensure SPS/PPS NALs do NOT start with Annex-B start codes.
// This avoids false positives from length fields containing 00 00 01.
static bool AvcCHasAnnexBInNalUnits(const uint8_t* p, size_t n)
{
    if (!p || n < 7) return true;
    if (p[0] != 0x01) return true;

    size_t off = 5;
    if (off >= n) return true;
    uint8_t numSps = (uint8_t)(p[off] & 0x1F);
    off += 1;
    for (uint8_t i = 0; i < numSps; ++i) {
        if (off + 2 > n) return true;
        uint16_t len = (uint16_t)p[off] << 8 | (uint16_t)p[off + 1];
        off += 2;
        if (len == 0 || off + len > n) return true;
        if (len >= 3 && p[off] == 0x00 && p[off + 1] == 0x00 && p[off + 2] == 0x01) return true;
        if (len >= 4 && p[off] == 0x00 && p[off + 1] == 0x00 && p[off + 2] == 0x00 && p[off + 3] == 0x01) return true;
        off += len;
    }

    if (off + 1 > n) return true;
    uint8_t numPps = p[off];
    off += 1;
    for (uint8_t i = 0; i < numPps; ++i) {
        if (off + 2 > n) return true;
        uint16_t len = (uint16_t)p[off] << 8 | (uint16_t)p[off + 1];
        off += 2;
        if (len == 0 || off + len > n) return true;
        if (len >= 3 && p[off] == 0x00 && p[off + 1] == 0x00 && p[off + 2] == 0x01) return true;
        if (len >= 4 && p[off] == 0x00 && p[off + 1] == 0x00 && p[off + 2] == 0x00 && p[off + 3] == 0x01) return true;
        off += len;
    }

    return false;
}

static bool StartsWithAnnexBStartCode(const uint8_t* p, size_t n)
{
    if (!p || n < 3) return false;
    if (p[0] != 0x00 || p[1] != 0x00) return false;
    if (p[2] == 0x01) return true;
    return (n >= 4 && p[2] == 0x00 && p[3] == 0x01);
}

static bool SetCodecparExtradata(AVCodecParameters* codecpar, const uint8_t* data, size_t size)
{
    if (!codecpar || !data || size == 0) return false;

    if (codecpar->extradata) {
        av_freep(&codecpar->extradata);
        codecpar->extradata_size = 0;
    }

    codecpar->extradata = (uint8_t*)av_malloc(size + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!codecpar->extradata) return false;
    memcpy(codecpar->extradata, data, size);
    memset(codecpar->extradata + size, 0, AV_INPUT_BUFFER_PADDING_SIZE);
    codecpar->extradata_size = (int)size;
    return true;
}

// Convert Annex-B (00 00 01 / 00 00 00 01 start-code delimited) H.264 into AVCC
// (4-byte big-endian length prefixed NAL units). Returns empty on failure.
static std::vector<uint8_t> AnnexBToAvcc(const uint8_t* data, size_t size)
{
    std::vector<uint8_t> out;
    if (!data || size < 4) return out;

    auto isStartCodeAt = [&](size_t pos, size_t* scLen) -> bool {
        if (pos + 3 < size && data[pos] == 0x00 && data[pos + 1] == 0x00) {
            if (data[pos + 2] == 0x01) { *scLen = 3; return true; }
            if (pos + 4 < size && data[pos + 2] == 0x00 && data[pos + 3] == 0x01) { *scLen = 4; return true; }
        }
        return false;
    };

    // Find the first start code.
    size_t i = 0;
    size_t scLen = 0;
    bool found = false;
    for (; i + 3 < size; ++i) {
        if (isStartCodeAt(i, &scLen)) { found = true; break; }
    }
    if (!found) return out;

    while (i < size) {
        // Skip start code
        if (!isStartCodeAt(i, &scLen)) {
            ++i;
            continue;
        }
        size_t nalStart = i + scLen;

        // Find next start code
        size_t j = nalStart;
        size_t nextScLen = 0;
        for (; j + 3 < size; ++j) {
            if (isStartCodeAt(j, &nextScLen)) break;
        }
        size_t nalEnd = (j + 3 < size) ? j : size;

        // Trim trailing zero padding
        while (nalEnd > nalStart && data[nalEnd - 1] == 0x00) {
            --nalEnd;
        }

        if (nalEnd > nalStart) {
            const size_t nalSize = nalEnd - nalStart;
            if (nalSize <= 0xFFFFFFFFu) {
                const uint32_t len = (uint32_t)nalSize;
                out.push_back((len >> 24) & 0xFF);
                out.push_back((len >> 16) & 0xFF);
                out.push_back((len >> 8) & 0xFF);
                out.push_back(len & 0xFF);
                out.insert(out.end(), data + nalStart, data + nalEnd);
            }
        }

        i = nalEnd;
    }

    return out;
}

#include <cstring>
#include <cstdio>
#include <vector>

/* ============================== */

static inline int64_t RescaleRounded(int64_t value, AVRational src, AVRational dst) {
    return av_rescale_q_rnd(
        value,
        src,
        dst,
        (AVRounding)(AV_ROUND_NEAR_INF | AV_ROUND_PASS_MINMAX));
}

static int AacSampleRateIndex(int sampleRate) {
    // MPEG-4 Audio samplingFrequencyIndex
    switch (sampleRate) {
        case 96000: return 0;
        case 88200: return 1;
        case 64000: return 2;
        case 48000: return 3;
        case 44100: return 4;
        case 32000: return 5;
        case 24000: return 6;
        case 22050: return 7;
        case 16000: return 8;
        case 12000: return 9;
        case 11025: return 10;
        case 8000:  return 11;
        case 7350:  return 12;
        default:    return -1;
    }
}


static bool SetAacAudioSpecificConfigExtradata(AVStream* stream, int sampleRate, int channels) {
    if (!stream || !stream->codecpar) return false;
    const int srIndex = AacSampleRateIndex(sampleRate);
    if (srIndex < 0) return false;

    // AudioSpecificConfig for AAC-LC (objectType=2), 2 bytes for common cases.
    // See ISO/IEC 14496-3.
    const uint8_t objectType = 2; // AAC LC
    const uint8_t channelConfig = (channels >= 0 && channels <= 7) ? (uint8_t)channels : 2;

    uint8_t asc[2];
    asc[0] = (uint8_t)((objectType << 3) | ((srIndex & 0x0F) >> 1));
    asc[1] = (uint8_t)(((srIndex & 0x01) << 7) | ((channelConfig & 0x0F) << 3));

    if (stream->codecpar->extradata) {
        av_freep(&stream->codecpar->extradata);
        stream->codecpar->extradata_size = 0;
    }

    stream->codecpar->extradata = (uint8_t*)av_malloc(sizeof(asc) + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!stream->codecpar->extradata) return false;
    memcpy(stream->codecpar->extradata, asc, sizeof(asc));
    memset(stream->codecpar->extradata + sizeof(asc), 0, AV_INPUT_BUFFER_PADDING_SIZE);
    stream->codecpar->extradata_size = (int)sizeof(asc);
    return true;
}

// Extract SPS/PPS NAL units from an H.264 packet buffer.
static void ExtractSpsPpsFromH264(const uint8_t* data, int size,
                                  std::vector<std::vector<uint8_t>>& spsList,
                                  std::vector<std::vector<uint8_t>>& ppsList)
{
    spsList.clear();
    ppsList.clear();
    if (!data || size <= 4) return;

    // Detect Annex-B (start codes) by scanning for 0x000001 within the first 64 bytes
    bool isAnnexB = false;
    int scanLimit = size < 64 ? size : 64;
    for (int i = 0; i + 3 < scanLimit; ++i) {
        if (data[i] == 0x00 && data[i+1] == 0x00 && data[i+2] == 0x01) { isAnnexB = true; break; }
        if (i + 4 < scanLimit && data[i] == 0x00 && data[i+1] == 0x00 && data[i+2] == 0x00 && data[i+3] == 0x01) { isAnnexB = true; break; }
    }

    if (isAnnexB) {
        // Parse start-code delimited NAL units
        int i = 0;
        while (i < size) {
            // find start code
            int sc = -1; // length of start code (3 or 4)
            if (i + 3 < size && data[i] == 0x00 && data[i+1] == 0x00 && data[i+2] == 0x01) sc = 3;
            else if (i + 4 < size && data[i] == 0x00 && data[i+1] == 0x00 && data[i+2] == 0x00 && data[i+3] == 0x01) sc = 4;
            if (sc < 0) { ++i; continue; }
            int nalStart = i + sc;
            int nalEnd = nalStart;
            // find next start code
            int j = nalStart;
            while (j < size) {
                if (j + 3 < size && data[j] == 0x00 && data[j+1] == 0x00 && data[j+2] == 0x01) break;
                if (j + 4 < size && data[j] == 0x00 && data[j+1] == 0x00 && data[j+2] == 0x00 && data[j+3] == 0x01) break;
                ++j;
            }
            nalEnd = j;
            if (nalEnd > nalStart) {
                const uint8_t* nal = data + nalStart;
                int nalSize = nalEnd - nalStart;
                uint8_t nalType = nal[0] & 0x1F;
                if (nalType == 7) spsList.emplace_back(nal, nal + nalSize);
                else if (nalType == 8) ppsList.emplace_back(nal, nal + nalSize);
            }
            i = nalEnd;
        }
    } else {
        // Try to detect 4-byte or 2-byte length-prefixed NAL arrays.
        bool parsed = false;
        // Heuristic: try 4-byte lengths first
        int tmp = 0;
        bool valid4 = true;
        while (tmp + 4 <= size) {
            uint32_t nalLen = (uint32_t)data[tmp] << 24 | (uint32_t)data[tmp+1] << 16 | (uint32_t)data[tmp+2] << 8 | (uint32_t)data[tmp+3];
            tmp += 4;
            if (nalLen == 0 || tmp + (int)nalLen > size) { valid4 = false; break; }
            tmp += (int)nalLen;
        }
        if (valid4 && tmp == size) {
            int pos = 0;
            while (pos + 4 <= size) {
                uint32_t nalLen = (uint32_t)data[pos] << 24 | (uint32_t)data[pos+1] << 16 | (uint32_t)data[pos+2] << 8 | (uint32_t)data[pos+3];
                pos += 4;
                if (nalLen == 0 || pos + (int)nalLen > size) break;
                const uint8_t* nal = data + pos;
                uint8_t nalType = nal[0] & 0x1F;
                if (nalType == 7) spsList.emplace_back(nal, nal + nalLen);
                else if (nalType == 8) ppsList.emplace_back(nal, nal + nalLen);
                pos += (int)nalLen;
            }
            parsed = true;
        }

        if (!parsed) {
            // Try 2-byte lengths
            tmp = 0;
            bool valid2 = true;
            while (tmp + 2 <= size) {
                uint16_t nalLen = (uint16_t)data[tmp] << 8 | (uint16_t)data[tmp+1];
                tmp += 2;
                if (nalLen == 0 || tmp + (int)nalLen > size) { valid2 = false; break; }
                tmp += (int)nalLen;
            }
            if (valid2 && tmp == size) {
                int pos = 0;
                while (pos + 2 <= size) {
                    uint16_t nalLen = (uint16_t)data[pos] << 8 | (uint16_t)data[pos+1];
                    pos += 2;
                    if (nalLen == 0 || pos + (int)nalLen > size) break;
                    const uint8_t* nal = data + pos;
                    uint8_t nalType = nal[0] & 0x1F;
                    if (nalType == 7) spsList.emplace_back(nal, nal + nalLen);
                    else if (nalType == 8) ppsList.emplace_back(nal, nal + nalLen);
                    pos += (int)nalLen;
                }
                parsed = true;
            }
        }
    }
}

// Build AVCDecoderConfigurationRecord (avcC) from SPS/PPS
static std::vector<uint8_t> BuildAvcC(const std::vector<std::vector<uint8_t>>& spsList,
                                      const std::vector<std::vector<uint8_t>>& ppsList)
{
    std::vector<uint8_t> out;
    if (spsList.empty() || ppsList.empty()) return out;

    // Sanitize SPS/PPS: ensure no leading Annex-B start codes remain
    std::vector<std::vector<uint8_t>> cleanSPS;
    std::vector<std::vector<uint8_t>> cleanPPS;
    auto sanitize = [](const std::vector<uint8_t>& v)->std::vector<uint8_t> {
        if (v.empty()) return v;
        size_t i = 0;
        // skip any leading 00 00 01 or 00 00 00 01
        while (i + 3 <= v.size()) {
            if (v[i] == 0x00 && v[i+1] == 0x00 && v[i+2] == 0x01) { i += 3; break; }
            if (i + 4 <= v.size() && v[i] == 0x00 && v[i+1] == 0x00 && v[i+2] == 0x00 && v[i+3] == 0x01) { i += 4; break; }
            break;
        }
        return std::vector<uint8_t>(v.begin() + i, v.end());
    };

    for (const auto& s : spsList) cleanSPS.push_back(sanitize(s));
    for (const auto& p : ppsList) cleanPPS.push_back(sanitize(p));

    const std::vector<uint8_t>& sps = cleanSPS[0];
    const std::vector<uint8_t>& pps = cleanPPS[0];
    if (sps.size() < 4) return out; // need profile/level bytes

    uint8_t profile = sps[1];
    uint8_t profile_compat = sps[2];
    uint8_t level = sps[3];

    // configurationVersion
    out.push_back(0x01);
    // AVCProfileIndication, profile_compatibility, AVCLevelIndication
    out.push_back(profile);
    out.push_back(profile_compat);
    out.push_back(level);
    // lengthSizeMinusOne (0b111111 + 2 bits lengthSizeMinusOne=3 for 4-byte lengths)
    out.push_back(0xFF);
    // numOfSequenceParameterSets (0b11100001 = 0xE1) and number of SPS (1)
    out.push_back(0xE0 | (uint8_t)(spsList.size() & 0x1F));

    // SPS entries
    for (const auto& s : cleanSPS) {
        uint16_t len = (uint16_t)s.size();
        out.push_back((len >> 8) & 0xFF);
        out.push_back(len & 0xFF);
        out.insert(out.end(), s.begin(), s.end());
    }

    // numOfPictureParameterSets
    out.push_back((uint8_t)ppsList.size());
    for (const auto& p : cleanPPS) {
        uint16_t len = (uint16_t)p.size();
        out.push_back((len >> 8) & 0xFF);
        out.push_back(len & 0xFF);
        out.insert(out.end(), p.begin(), p.end());
    }

    // Additional data required for high profiles (100,110,122,244)
    // Parse chroma/bit-depth from SPS RBSP if present and append profile-specific fields.
    if (profile == 100 || profile == 110 || profile == 122 || profile == 244) {
        // Extract RBSP (remove emulation_prevention_three_byte bytes 0x03)
        const uint8_t* sps_ptr = sps.data();
        size_t sps_size = sps.size();
        if (sps_size > 1) {
            // Create RBSP buffer
            std::vector<uint8_t> rbsp;
            rbsp.reserve(sps_size);
            size_t i = 1; // skip NAL header byte
            rbsp.push_back(sps_ptr[0]);
            while (i + 2 < sps_size) {
                if (sps_ptr[i] == 0 && sps_ptr[i+1] == 0 && sps_ptr[i+2] == 3) {
                    rbsp.push_back(sps_ptr[i++]);
                    rbsp.push_back(sps_ptr[i++]);
                    // skip the 0x03
                    i++;
                } else {
                    rbsp.push_back(sps_ptr[i++]);
                }
            }
            while (i < sps_size) rbsp.push_back(sps_ptr[i++]);

            // Simple bitstream reader for UE Golomb
            struct BitReader {
                const uint8_t* data;
                size_t size;
                size_t byte_pos;
                int bit_pos;
                void init(const uint8_t* d, size_t s) { data = d; size = s; byte_pos = 0; bit_pos = 7; }
                uint32_t read_bits(int n) {
                    uint32_t v = 0;
                    for (int k = 0; k < n; ++k) {
                        if (byte_pos >= size) return v;
                        v <<= 1;
                        v |= (uint32_t)((data[byte_pos] >> bit_pos) & 1);
                        --bit_pos;
                        if (bit_pos < 0) { bit_pos = 7; ++byte_pos; }
                    }
                    return v;
                }
            };

            auto get_ue = [&](BitReader &br)->uint32_t {
                int zeros = 0;
                while (true) {
                    uint32_t b = br.read_bits(1);
                    if (b == 0) zeros++; else break;
                    if (zeros > 31) break;
                }
                if (zeros == 0) return 0;
                uint32_t val = br.read_bits(zeros);
                return (1u << zeros) - 1 + val;
            };

            // Read relevant fields
            BitReader br;
            br.init(rbsp.data(), rbsp.size());
            // skip profile/constraint/level (24 bits)
            (void)br.read_bits(8);
            (void)br.read_bits(8);
            (void)br.read_bits(8);
            // skip seq_parameter_set_id (UE)
            (void)get_ue(br);

            uint8_t chroma_format_idc = (uint8_t)get_ue(br);
            if (chroma_format_idc == 3) {
                // skip separate_colour_plane_flag
                (void)br.read_bits(1);
            }
            uint8_t bit_depth_luma_minus8 = (uint8_t)get_ue(br);
            uint8_t bit_depth_chroma_minus8 = (uint8_t)get_ue(br);

            // reserved + chroma_format
            out.push_back((uint8_t)(0xFC | (chroma_format_idc & 0x03)));
            // reserved + bit_depth_luma_minus8
            out.push_back((uint8_t)(0xF8 | (bit_depth_luma_minus8 & 0x07)));
            // reserved + bit_depth_chroma_minus8
            out.push_back((uint8_t)(0xF8 | (bit_depth_chroma_minus8 & 0x07)));
            // numOfSequenceParameterSetExt
            out.push_back(0x00);
        }
    }

    return out;
}

StreamMuxer::StreamMuxer()
    : m_initialized(false),
      m_isConnected(false),
      m_dropVideoPackets(false),
      m_dropAllPackets(false),
      m_formatContext(nullptr),
      m_videoStream(nullptr),
      m_audioStream(nullptr),
      m_audioCodecContext(nullptr),
      m_originalVideoTimeBase({0,1}),
      m_lastVideoPTS(0),
      m_lastVideoDTS(0),
      m_lastAudioPTS(0),
      m_videoFrameCount(0),
      m_audioSampleCount(0),
      m_audioSamplesWritten(0),
      m_streamStartUs(-1),
      m_sentFirstVideoKeyframe(false),
      m_videoPacketCount(0),
      m_audioPacketCount(0),
      m_totalBytes(0),
      m_videoPacketsDropped(0),
      m_audioPacketsDropped(0),
      m_buffer(nullptr)
{
    avformat_network_init();
}

StreamMuxer::~StreamMuxer() {
    if (m_initialized) {
        Flush();
        Cleanup();
    }
    avformat_network_deinit();
}

/* ============================== */

bool StreamMuxer::Initialize(const std::string& rtmpUrl,
                             VideoEncoder* videoEncoder,
                             uint32_t audioSampleRate,
                             uint16_t audioChannels,
                             uint32_t audioBitrate)
{
    if (m_initialized || !videoEncoder) return false;

    m_headerWritten = false;

    m_rtmpUrl = rtmpUrl;

    if (avformat_alloc_output_context2(&m_formatContext, nullptr, "flv",
                                       rtmpUrl.c_str()) < 0)
        return false;

    if (!SetupVideoStream(videoEncoder)) return false;
    if (!SetupAudioStream(audioSampleRate, audioChannels, audioBitrate)) return false;

    if (!(m_formatContext->oformat->flags & AVFMT_NOFILE)) {
        if (avio_open2(&m_formatContext->pb, rtmpUrl.c_str(),
                       AVIO_FLAG_WRITE, nullptr, nullptr) < 0)
            return false;
    }

    // OBS-like behavior: delay avformat_write_header until we have valid H.264 avcC extradata.
    // Some encoders (notably NVENC) may not populate AVCodecContext::extradata until the first
    // keyframe is produced, and they often output Annex-B bytestream which must be packetized.
    if (m_videoStream && m_videoStream->codecpar && m_videoStream->codecpar->extradata_size > 0) {
        if (avformat_write_header(m_formatContext, nullptr) < 0)
            return false;
        m_headerWritten = true;

        if (m_videoStream && m_audioStream) {
            Ionia::LogInfof(
                "[StreamMuxer] Post-header time_base: video={%d/%d} audio={%d/%d}\n",
                m_videoStream->time_base.num, m_videoStream->time_base.den,
                m_audioStream->time_base.num, m_audioStream->time_base.den);
        }
    } else {
        Ionia::LogInfof("[StreamMuxer] Deferring avformat_write_header until H.264 avcC is available\n");
    }

    // Provide time_base info to the StreamBuffer.
    // If the header is deferred, we still set initial time_bases (they may be adjusted later).
    if (m_buffer && m_videoStream && m_audioStream) {
        m_buffer->SetStreamInfo(
            m_videoStream->index, m_videoStream->time_base,
            m_audioStream->index, m_audioStream->time_base);
    }

    // Note: do NOT manually write FLV AAC/AVC "sequence header" packets here.
    // When using libavformat's FLV muxer, you must provide codec extradata
    // (AAC AudioSpecificConfig, H264 avcC) and then write raw AAC/H264 packets.
    // Manually injecting FLV-tag payloads via av_write_frame() corrupts the stream.

    // Reset pacing state (used by buffered network send)
    m_streamStartUs = -1;
    m_firstPacketDtsUs = -1;

    m_initialized = true;
    m_isConnected = true;
    return true;
}

/* ============================== */

bool StreamMuxer::SetupVideoStream(VideoEncoder* encoder) {
    const AVCodec* codec = avcodec_find_encoder(AV_CODEC_ID_H264);
    if (!codec) return false;

    m_videoStream = avformat_new_stream(m_formatContext, codec);
    if (!m_videoStream) return false;

    m_videoEncoder = encoder;  // Store pointer for later use

    AVCodecContext* ctx = avcodec_alloc_context3(codec);
    if (!ctx) return false;

    uint32_t w,h;
    encoder->GetDimensions(&w,&h);
    uint32_t fps = encoder->GetFPS();

    ctx->width = w;
    ctx->height = h;
    ctx->time_base = {1,(int)fps};
    ctx->framerate = {(int)fps,1};
    ctx->pix_fmt = AV_PIX_FMT_YUV420P;
    ctx->codec_type = AVMEDIA_TYPE_VIDEO;

    avcodec_parameters_from_context(m_videoStream->codecpar, ctx);

    // Copy extradata (SPS/PPS) from encoder's codec context if available.
    // IMPORTANT: For H.264 in FLV/RTMP, codecpar->extradata must be an avcC
    // (AVCDecoderConfigurationRecord) WITHOUT Annex-B start codes.
    AVCodecContext* encoderCtx = encoder->GetCodecContext();
    if (encoderCtx && encoderCtx->extradata && encoderCtx->extradata_size > 0) {
        const uint8_t* ed = encoderCtx->extradata;
        int ed_size = encoderCtx->extradata_size;

        // If extradata already looks like avcC (starts with 0x01), copy it directly.
        if (ed_size >= 7 && ed[0] == 0x01) {
            if (StartsWithAnnexBStartCode(ed, (size_t)ed_size) || AvcCHasAnnexBInNalUnits(ed, (size_t)ed_size)) {
                Ionia::LogErrorf("[FATAL] Encoder extradata claims avcC but contains Annex-B start codes\n");
                abort();
            }

            if (m_videoStream->codecpar->extradata) {
                av_freep(&m_videoStream->codecpar->extradata);
                m_videoStream->codecpar->extradata_size = 0;
            }
            m_videoStream->codecpar->extradata = (uint8_t*)av_malloc(ed_size + AV_INPUT_BUFFER_PADDING_SIZE);
            if (m_videoStream->codecpar->extradata) {
                memcpy(m_videoStream->codecpar->extradata, ed, ed_size);
                memset(m_videoStream->codecpar->extradata + ed_size, 0, AV_INPUT_BUFFER_PADDING_SIZE);
                m_videoStream->codecpar->extradata_size = ed_size;
            }
        } else {
            // Build avcC from whatever format the encoder provided (Annex-B or AVCC).
            std::vector<std::vector<uint8_t>> spsList;
            std::vector<std::vector<uint8_t>> ppsList;
            ExtractSpsPpsFromH264(ed, ed_size, spsList, ppsList);
            if (!spsList.empty() && !ppsList.empty()) {
                std::vector<uint8_t> avcC = BuildAvcC(spsList, ppsList);
                if (!avcC.empty()) {
                    if (StartsWithAnnexBStartCode(avcC.data(), avcC.size()) || AvcCHasAnnexBInNalUnits(avcC.data(), avcC.size())) {
                        Ionia::LogErrorf("[FATAL] Built avcC extradata contains Annex-B start codes\n");
                        abort();
                    }

                    if (m_videoStream->codecpar->extradata) {
                        av_freep(&m_videoStream->codecpar->extradata);
                        m_videoStream->codecpar->extradata_size = 0;
                    }
                    m_videoStream->codecpar->extradata = (uint8_t*)av_malloc(avcC.size() + AV_INPUT_BUFFER_PADDING_SIZE);
                    if (m_videoStream->codecpar->extradata) {
                        memcpy(m_videoStream->codecpar->extradata, avcC.data(), avcC.size());
                        memset(m_videoStream->codecpar->extradata + avcC.size(), 0, AV_INPUT_BUFFER_PADDING_SIZE);
                        m_videoStream->codecpar->extradata_size = (int)avcC.size();
                    }
                }
            }
        }
    }

    m_videoStream->time_base = {1, 1000};  // OBS-style: millisecond time_base
    m_videoStream->avg_frame_rate = ctx->framerate;
    m_videoStream->r_frame_rate = ctx->framerate;

    m_originalVideoTimeBase = ctx->time_base;

    avcodec_free_context(&ctx);
    return true;
}

bool StreamMuxer::SetupAudioStream(uint32_t rate, uint16_t ch, uint32_t br) {
    const AVCodec* codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (!codec) return false;

    m_audioStream = avformat_new_stream(m_formatContext, codec);
    if (!m_audioStream) return false;

    m_audioCodecContext = avcodec_alloc_context3(codec);
    m_audioCodecContext->sample_rate = rate;
    m_audioCodecContext->ch_layout.nb_channels = ch;
    av_channel_layout_default(&m_audioCodecContext->ch_layout, ch);
    m_audioCodecContext->sample_fmt = AV_SAMPLE_FMT_FLTP;
    m_audioCodecContext->bit_rate = br;
    m_audioCodecContext->time_base = {1,(int)rate};

    Ionia::LogDebugf("[SetupAudioStream] Setting time_base to {1, %d} for sample rate %d\n", rate, rate);

    avcodec_parameters_from_context(
        m_audioStream->codecpar, m_audioCodecContext);

    // Provide AAC AudioSpecificConfig as codec extradata so the FLV muxer can emit
    // the proper AAC sequence header (AudioSpecificConfig) automatically.
    if (!SetAacAudioSpecificConfigExtradata(m_audioStream, (int)rate, (int)ch)) {
        Ionia::LogErrorf("[SetupAudioStream] Failed to set AAC AudioSpecificConfig extradata\n");
        return false;
    }

    // FLV/RTMP uses millisecond timestamps. The FLV muxer may overwrite time_base to {1/1000}.
    // Set it upfront to avoid timestamp discontinuities when we defer header writing.
    m_audioStream->time_base = {1, 1000};
    
    return true;
}

/* ============================== */

bool StreamMuxer::WriteVideoPacket(const void* p, int64_t frameIndex)
{
    if (!m_initialized || !m_isConnected || m_dropAllPackets)
        return false;

    const auto* pktIn =
        static_cast<const VideoEncoder::EncodedPacket*>(p);
    if (pktIn->data.empty())
        return false;

    // Accept Annex-B from encoders (NVENC commonly emits Annex-B). Convert to AVCC for FLV/RTMP.
    const bool inputIsAnnexB = StartsWithAnnexBStartCode(pktIn->data.data(), pktIn->data.size());
    std::vector<uint8_t> convertedAvcc;
    const uint8_t* payload = pktIn->data.data();
    size_t payloadSize = pktIn->data.size();
    if (inputIsAnnexB) {
        convertedAvcc = AnnexBToAvcc(payload, payloadSize);
        if (convertedAvcc.empty()) {
            Ionia::LogErrorf("[StreamMuxer] AnnexBToAvcc failed (size=%zu)\n", payloadSize);
            return false;
        }
        payload = convertedAvcc.data();
        payloadSize = convertedAvcc.size();
    }

    // If we haven't written the FLV header yet, ensure we have valid avcC extradata.
    // Prefer extracting SPS/PPS from the first keyframe packet.
    if (!m_headerWritten) {
        const bool haveAvcC = (m_videoStream && m_videoStream->codecpar && m_videoStream->codecpar->extradata_size > 0);
        if (!haveAvcC && pktIn->isKeyframe) {
            std::vector<std::vector<uint8_t>> spsList;
            std::vector<std::vector<uint8_t>> ppsList;
            ExtractSpsPpsFromH264(pktIn->data.data(), (int)pktIn->data.size(), spsList, ppsList);
            if (!spsList.empty() && !ppsList.empty()) {
                std::vector<uint8_t> avcC = BuildAvcC(spsList, ppsList);
                if (!avcC.empty()) {
                    if (StartsWithAnnexBStartCode(avcC.data(), avcC.size()) || AvcCHasAnnexBInNalUnits(avcC.data(), avcC.size())) {
                        Ionia::LogErrorf("[StreamMuxer] Built avcC extradata invalid (contains Annex-B)\n");
                        return false;
                    }
                    (void)SetCodecparExtradata(m_videoStream->codecpar, avcC.data(), avcC.size());
                }
            }
        }

        const bool ready = (m_videoStream && m_videoStream->codecpar && m_videoStream->codecpar->extradata_size > 0);
        if (ready) {
            if (avformat_write_header(m_formatContext, nullptr) < 0) {
                Ionia::LogErrorf("[StreamMuxer] avformat_write_header failed (deferred)\n");
                m_isConnected = false;
                return false;
            }
            m_headerWritten = true;

            if (m_videoStream && m_audioStream) {
                Ionia::LogInfof(
                    "[StreamMuxer] Post-header time_base: video={%d/%d} audio={%d/%d}\n",
                    m_videoStream->time_base.num, m_videoStream->time_base.den,
                    m_audioStream->time_base.num, m_audioStream->time_base.den);
            }

            if (m_buffer && m_videoStream && m_audioStream) {
                m_buffer->SetStreamInfo(
                    m_videoStream->index, m_videoStream->time_base,
                    m_audioStream->index, m_audioStream->time_base);
            }
        }
    }

    AVPacket* pkt = av_packet_alloc();
    av_new_packet(pkt, (int)payloadSize);
    memcpy(pkt->data, payload, payloadSize);

    // Do not send frames before first IDR
    if (!m_sentFirstVideoKeyframe && !pktIn->isKeyframe) {
        av_packet_free(&pkt);
        return false;
    }

    const uint32_t fps = m_videoEncoder ? m_videoEncoder->GetFPS() : 30;
    const AVRational srcTb{1, (int)fps};
    const AVRational dstTb = m_videoStream->time_base;

    const int64_t pts = RescaleRounded(frameIndex, srcTb, dstTb);
    const int64_t nextPts = RescaleRounded(frameIndex + 1, srcTb, dstTb);

    pkt->pts = pts;
    pkt->dts = pts;
    pkt->duration = std::max<int64_t>(1, nextPts - pts);
    pkt->stream_index = m_videoStream->index;

    if (pktIn->isKeyframe) {
        pkt->flags |= AV_PKT_FLAG_KEY;
        m_sentFirstVideoKeyframe = true;
    }

    if (pkt->dts <= m_lastWrittenVideoDTS) {
        av_packet_free(&pkt);
        return false;
    }
    m_lastWrittenVideoDTS = pkt->dts;

    if (m_buffer) {
        if (!m_buffer->AddPacket(pkt)) {
            m_videoPacketsDropped++;
            return false;
        }
    } else {
        int ret = av_interleaved_write_frame(m_formatContext, pkt);
        av_packet_free(&pkt);
        if (ret < 0) {
            char errbuf[256];
            av_strerror(ret, errbuf, sizeof(errbuf));
            Ionia::LogErrorf("[StreamMuxer] WriteVideoPacket failed: %s\n", errbuf);
            m_isConnected = false;
            return false;
        }
    }

    m_videoPacketCount++;
    m_totalBytes += payloadSize;
    return true;
}


bool StreamMuxer::WriteAudioPacket(const EncodedAudioPacket& p) {
    if (!m_initialized || !m_isConnected)
        return false;
    
    // Note: We DON'T require m_sentFirstVideoKeyframe for audio
    // Audio can be buffered until video starts
    // This prevents audio drop when video is still initializing

    AVPacket* pkt = av_packet_alloc();
    if (!pkt) return false;

    av_new_packet(pkt, (int)p.data.size());
    memcpy(pkt->data, p.data.data(), p.data.size());

    // Audio clock: cumulative samples in {1/sample_rate}. Convert into the muxer's chosen
    // stream time_base using rounded rescaling, and derive duration from nextPts-pts
    // to avoid drift (which can present as "accelerated" playback).
    const int sr = (m_audioCodecContext && m_audioCodecContext->sample_rate) ? m_audioCodecContext->sample_rate : 48000;
    const AVRational audioSrcTb{1, sr};
    const AVRational audioDstTb = m_audioStream->time_base;

    const int64_t curSamples = m_audioSamplesWritten;
    const int64_t nextSamples = curSamples + p.numSamples;

    const int64_t pts = RescaleRounded(curSamples, audioSrcTb, audioDstTb);
    int64_t nextPts = RescaleRounded(nextSamples, audioSrcTb, audioDstTb);
    if (nextPts <= pts) nextPts = pts + 1;

    pkt->pts = pts;
    pkt->dts = pts;
    pkt->duration = nextPts - pts;
    pkt->stream_index = m_audioStream->index;

    // MONOTONIC DTS CHECK
    if (pkt->dts <= m_lastWrittenAudioDTS) {
        av_packet_free(&pkt);
        return false;
    }
    m_lastWrittenAudioDTS = pkt->dts;

    m_audioSamplesWritten = nextSamples;

    if (m_buffer) {
        if (!m_buffer->AddPacket(pkt)) {
            m_audioPacketsDropped++;
            return false;
        }
    } else {
        int ret = av_interleaved_write_frame(m_formatContext, pkt);
        av_packet_free(&pkt);
        if (ret < 0) {
            char errbuf[256];
            av_strerror(ret, errbuf, sizeof(errbuf));
            Ionia::LogErrorf("[StreamMuxer] WriteAudioPacket av_interleaved_write_frame failed: %s\n", errbuf);
            m_isConnected = false;
            return false;
        }
    }

    m_audioPacketCount++;
    m_totalBytes += p.data.size();
    return true;
}

void StreamMuxer::SendAACSequenceHeader() {
    if (!m_audioStream || !m_audioCodecContext || m_sentAACSequenceHeader)
        return;

    // Build FLV AAC sequence header
    // Format: [AACPacketType=0] [AudioSpecificConfig]
    
    // Get AudioSpecificConfig from encoder
    // For AAC LC, this is typically 2 bytes
    uint8_t audioSpecificConfig[2] = {0};
    
    // Simplified: construct from sample rate and channels
    // Real implementation would read from AVCodecContext
    int sample_rate_idx = 4; // 48kHz
    switch (m_audioCodecContext->sample_rate) {
        case 44100: sample_rate_idx = 4; break;
        case 48000: sample_rate_idx = 3; break;
        case 96000: sample_rate_idx = 1; break;
        default: return;
    }
    
    int channels = m_audioCodecContext->ch_layout.nb_channels;
    
    // AudioSpecificConfig format (MPEG-4 Audio):
    // [5 bits: object type] [4 bits: sample rate idx] [4 bits: channel config] [3 bits: frame length flag + depends on object type]
    // Object type 2 = AAC LC
    audioSpecificConfig[0] = ((2 << 3) | (sample_rate_idx >> 1)) & 0xFF;
    audioSpecificConfig[1] = ((sample_rate_idx << 7) | (channels << 3)) & 0xFF;

    AVPacket* pkt = av_packet_alloc();
    av_new_packet(pkt, 1 + sizeof(audioSpecificConfig));
    
    pkt->data[0] = 0; // AACPacketType = 0 (sequence header)
    memcpy(pkt->data + 1, audioSpecificConfig, sizeof(audioSpecificConfig));

    pkt->pts = 0;
    pkt->dts = 0;
    pkt->duration = 0;
    pkt->stream_index = m_audioStream->index;

    av_write_frame(m_formatContext, pkt);
    av_packet_free(&pkt);
    
    m_sentAACSequenceHeader = true;
}

/* ============================== */

bool StreamMuxer::SendNextBufferedPacket() {
    if (!m_buffer || !m_isConnected) return false;

    // Don't send anything until the muxer header is written.
    if (!m_headerWritten) return false;

    AVPacket* pkt = m_buffer->GetNextPacket();
    if (!pkt) return false;

    // ================== REAL-TIME PACING ==================
    // The network thread can drain the buffer faster than real time.
    // Sleep until this packet's DTS is due (relative to the first packet sent).
    // This prevents "accelerated" playback where timeline advances faster than wall time.
    if (m_formatContext && pkt->stream_index >= 0 && pkt->stream_index < (int)m_formatContext->nb_streams) {
        const AVRational tb = m_formatContext->streams[pkt->stream_index]->time_base;
        const int64_t pktDtsUs = av_rescale_q(pkt->dts, tb, AVRational{1, 1000000});

        if (m_streamStartUs < 0 || m_firstPacketDtsUs < 0) {
            m_streamStartUs = av_gettime_relative();
            m_firstPacketDtsUs = pktDtsUs;
        } else {
            const int64_t nowUs = av_gettime_relative();
            const int64_t elapsedUs = nowUs - m_streamStartUs;
            const int64_t targetUs = pktDtsUs - m_firstPacketDtsUs;

            // Small tolerance to avoid micro-sleeps (and give the muxer a tiny lead).
            const int64_t toleranceUs = 2000;
            if (targetUs > elapsedUs + toleranceUs) {
                int64_t sleepUs = targetUs - elapsedUs;
                if (sleepUs > 250000) sleepUs = 250000; // cap at 250ms per packet
                if (sleepUs > 0) {
                    av_usleep((unsigned int)sleepUs);
                }
            }
        }
    }

    int ret = av_interleaved_write_frame(m_formatContext, pkt);
    av_packet_free(&pkt);

    if (ret < 0) {
        char errbuf[256];
        av_strerror(ret, errbuf, sizeof(errbuf));
        Ionia::LogErrorf("[StreamMuxer] SendNextBufferedPacket av_interleaved_write_frame failed: %s\n", errbuf);
        m_isConnected = false;
        return false;
    }
    return true;
}

bool StreamMuxer::Flush() {
    if (!m_initialized) return false;
    av_write_frame(m_formatContext, nullptr);
    return true;
}

void StreamMuxer::Cleanup() {
    if (m_formatContext) {
        if (!(m_formatContext->oformat->flags & AVFMT_NOFILE))
            avio_closep(&m_formatContext->pb);
        avformat_free_context(m_formatContext);
        m_formatContext = nullptr;
    }
    avcodec_free_context(&m_audioCodecContext);
    m_initialized = false;
    m_headerWritten = false;
}

bool StreamMuxer::IsBackpressure() const {
    return m_buffer && m_buffer->IsBackpressure();
}

bool StreamMuxer::CheckRtmpConnection() {
    return m_isConnected;
}

bool StreamMuxer::ReconnectRtmp() {
    return false;
}
