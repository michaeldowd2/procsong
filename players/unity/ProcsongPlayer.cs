using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;
using UnityEngine;

namespace Procsong
{
    /// <summary>
    /// Unity player for a Procsong package. Assign a <c>.bytes</c> file (the zip renamed),
    /// then call <see cref="Play"/> when you want music — it does not start on its own.
    ///
    /// The zip is unpacked into memory on the first Play(), not when the scene loads.
    /// Nothing is written to disk.
    /// </summary>
    [DisallowMultipleComponent]
    [AddComponentMenu("Audio/Procsong Player")]
    public sealed class ProcsongPlayer : MonoBehaviour
    {
        const float FadeSec = 0.008f;
        const float LookaheadSec = 1f;
        const float StartDelaySec = 0.08f;

        [Header("Package")]
        [Tooltip("Rename the procsong zip to .bytes in Assets, then drag it here. Unity does not include raw .zip files in builds.")]
        [SerializeField] TextAsset songPackage;

        [Header("Playback")]
        [Tooltip("Integer seed. The same package + seed always produces the same arrangement.")]
        [SerializeField] string seed = "12345";

        [SerializeField, Range(0f, 1f)] float volume = 0.85f;
        [SerializeField, Range(0f, 1f)] float spatialBlend;
        [Tooltip("Log the first evaluations to the Console (useful for checking seed 12345 against the spec).")]
        [SerializeField] bool logSchedule;

        List<ProcsongTrack> _tracks;
        Dictionary<string, AudioClip> _clips;
        TextAsset _loadedPackage;
        ProcsongEngine _engine;
        readonly List<Voice> _voices = new List<Voice>();
        bool _playing;
        double _audioOrigin;

        sealed class Voice
        {
            public AudioSource Source;
            public double EndDsp;
        }

        public bool IsPlaying { get { return _playing; } }
        public string Seed { get { return seed; } set { seed = value; } }
        public float Volume { get { return volume; } set { volume = Mathf.Clamp01(value); ApplyVolume(); } }

        /// <summary>Start the current package with the inspector seed. No-op if already playing.</summary>
        [ContextMenu("Play")]
        public void Play()
        {
            if (_playing) return;
            try
            {
                EnsureLoaded();
                ulong parsed = ProcsongRng.ParseSeed(seed);
                if (logSchedule)
                {
                    var probe = new ProcsongEngine(_tracks, parsed);
                    Debug.Log(FormatTrace(probe.Trace(5), seed), this);
                }
                _engine = new ProcsongEngine(_tracks, parsed);
                _audioOrigin = AudioSettings.dspTime + StartDelaySec;
                ApplyResults(0, _engine.EvaluateDue(0));
                _playing = true;
#if UNITY_2023_1_OR_NEWER
                if (FindAnyObjectByType<AudioListener>() == null)
#else
                if (FindObjectOfType<AudioListener>() == null)
#endif
                    Debug.LogWarning("ProcsongPlayer: no AudioListener in the scene (usually on the camera), so you will not hear audio.", this);
            }
            catch (Exception ex)
            {
                Stop();
                Debug.LogException(ex, this);
            }
        }

        /// <summary>Stop all scheduled and playing clips. Safe to call when already stopped.</summary>
        [ContextMenu("Stop")]
        public void Stop()
        {
            _playing = false;
            _engine = null;
            for (int i = 0; i < _voices.Count; i++)
            {
                if (_voices[i].Source != null) _voices[i].Source.Stop();
                _voices[i].EndDsp = 0;
            }
        }

        /// <summary>Stop if needed, then start from t = 0 with the current seed.</summary>
        public void Restart()
        {
            Stop();
            Play();
        }

        /// <summary>Set the seed and start (or restart) playback. Useful from UnityEvents.</summary>
        public void PlayWithSeed(string newSeed)
        {
            seed = newSeed;
            Restart();
        }

        [ContextMenu("Dump First 100 Evaluations")]
        public void DumpEvaluations()
        {
            try
            {
                EnsureLoaded();
                var probe = new ProcsongEngine(_tracks, ProcsongRng.ParseSeed(seed));
                Debug.Log(FormatTrace(probe.Trace(100), seed), this);
            }
            catch (Exception ex)
            {
                Debug.LogException(ex, this);
            }
        }

        void OnDisable()
        {
            Stop();
        }

        void OnDestroy()
        {
            Stop();
            for (int i = 0; i < _voices.Count; i++)
            {
                if (_voices[i].Source != null) Destroy(_voices[i].Source.gameObject);
            }
            _voices.Clear();
            UnloadClips();
        }

        void Update()
        {
            if (!_playing || _engine == null) return;
            try
            {
                ApplyVolume();
                double nowSec = AudioSettings.dspTime - _audioOrigin;
                int horizon = (int)Math.Floor(nowSec + LookaheadSec);
                while (_engine.PeekNextTick() <= horizon)
                {
                    int tick = _engine.PeekNextTick();
                    var due = _engine.EvaluateDue(tick);
                    if (due.Count == 0) break;
                    ApplyResults(tick, due);
                }
            }
            catch (Exception ex)
            {
                Stop();
                Debug.LogException(ex, this);
            }
        }

        void ApplyResults(int tick, List<ProcsongPulse> results)
        {
            double when = _audioOrigin + tick;
            for (int i = 0; i < results.Count; i++)
            {
                var result = results[i];
                if (result.Muted || string.IsNullOrEmpty(result.Chosen)) continue;
                AudioClip clip;
                if (_clips == null || !_clips.TryGetValue(ClipKey(result.Chosen), out clip) || clip == null)
                    continue;
                StartFullClip(clip, when);
            }
        }

        void StartFullClip(AudioClip clip, double when)
        {
            AudioSource source = AcquireVoice(when, clip.length);
            source.Stop();
            source.clip = clip;
            source.volume = volume;
            source.spatialBlend = spatialBlend;
            source.PlayScheduled(when);
        }

        AudioSource AcquireVoice(double when, float duration)
        {
            for (int i = 0; i < _voices.Count; i++)
            {
                if (_voices[i].Source != null && _voices[i].EndDsp <= when)
                {
                    _voices[i].EndDsp = when + duration;
                    return _voices[i].Source;
                }
            }
            var go = new GameObject("ProcsongVoice " + _voices.Count);
            go.transform.SetParent(transform, false);
            go.hideFlags = HideFlags.DontSave;
            var src = go.AddComponent<AudioSource>();
            src.playOnAwake = false;
            src.loop = false;
            src.spatialBlend = spatialBlend;
            src.dopplerLevel = 0f;
            src.priority = 32;
            _voices.Add(new Voice { Source = src, EndDsp = when + duration });
            return src;
        }

        void ApplyVolume()
        {
            for (int i = 0; i < _voices.Count; i++)
            {
                if (_voices[i].Source != null) _voices[i].Source.volume = volume;
            }
        }

        void EnsureLoaded()
        {
            if (_tracks != null && _loadedPackage == songPackage)
                return;

            UnloadClips();
            string yaml;
            Dictionary<string, byte[]> bytes;
            LoadPackageFiles(out yaml, out bytes);
            _tracks = ProcsongEngine.ParseDefinition(yaml);
            _clips = new Dictionary<string, AudioClip>();
            var needed = new HashSet<string>();
            for (int t = 0; t < _tracks.Count; t++)
            {
                var parts = _tracks[t].Parts;
                for (int p = 0; p < parts.Count; p++)
                    needed.Add(ClipKey(parts[p].Path));
            }

            int decoded = 0;
            foreach (string key in needed)
            {
                byte[] wav;
                if (!bytes.TryGetValue(key, out wav) || wav == null)
                {
                    Debug.LogWarning("ProcsongPlayer: missing clip '" + key + "'", this);
                    continue;
                }
                try
                {
                    _clips[key] = Wav.ToAudioClip(wav, key);
                    decoded++;
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("ProcsongPlayer: could not decode '" + key + "': " + ex.Message, this);
                }
            }

            bytes.Clear();
            _loadedPackage = songPackage;
            Debug.Log("ProcsongPlayer: loaded " + _tracks.Count + " tracks, " + decoded + " clips.", this);
        }

        void LoadPackageFiles(out string yaml, out Dictionary<string, byte[]> clips)
        {
            if (songPackage == null || songPackage.bytes == null || songPackage.bytes.Length == 0)
            {
                throw new InvalidOperationException(
                    "Assign a procsong .bytes file on Song Package. " +
                    "Copy the zip into Assets and rename it .bytes — Unity does not include raw .zip files in player builds.");
            }
            UnpackZip(songPackage.bytes, out yaml, out clips);
        }

        static void UnpackZip(byte[] zip, out string yaml, out Dictionary<string, byte[]> clips)
        {
            var files = Zip.Read(zip);
            string defPath = null;
            byte[] defBytes = null;
            int bestDepth = int.MaxValue;
            int bestLen = int.MaxValue;
            foreach (var pair in files)
            {
                string name = pair.Key.Replace('\\', '/');
                if (!name.EndsWith("definition.yml", StringComparison.OrdinalIgnoreCase)) continue;
                int depth = Depth(name);
                if (depth < bestDepth || (depth == bestDepth && name.Length < bestLen))
                {
                    bestDepth = depth;
                    bestLen = name.Length;
                    defPath = name;
                    defBytes = pair.Value;
                }
            }
            if (defPath == null || defBytes == null)
                throw new InvalidOperationException("Zip does not contain definition.yml");

            yaml = Encoding.UTF8.GetString(defBytes).TrimStart('\uFEFF');
            int slash = defPath.LastIndexOf('/');
            string root = slash < 0 ? "" : defPath.Substring(0, slash + 1);
            clips = new Dictionary<string, byte[]>();
            foreach (var pair in files)
            {
                string name = pair.Key.Replace('\\', '/');
                if (string.Equals(name, defPath, StringComparison.OrdinalIgnoreCase)) continue;
                if (!string.IsNullOrEmpty(root) && (name.Length < root.Length || string.CompareOrdinal(name, 0, root, 0, root.Length) != 0))
                    continue;
                string relative = name.Substring(root.Length);
                if (relative.Length == 0 || ShouldSkipPath(relative)) continue;
                clips[ClipKey(relative)] = pair.Value;
            }
        }

        void UnloadClips()
        {
            if (_clips != null)
            {
                foreach (var pair in _clips)
                {
                    if (pair.Value != null) Destroy(pair.Value);
                }
                _clips = null;
            }
            _tracks = null;
            _loadedPackage = null;
        }

        static bool ShouldSkipPath(string name)
        {
            string n = name.Replace('\\', '/');
            if (n.IndexOf("__MACOSX", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            int slash = n.LastIndexOf('/');
            string leaf = slash < 0 ? n : n.Substring(slash + 1);
            return leaf == ".DS_Store" || leaf.StartsWith("._");
        }

        static int Depth(string path)
        {
            int n = 0;
            for (int i = 0; i < path.Length; i++)
            {
                if (path[i] == '/' || path[i] == '\\') n++;
            }
            return n;
        }

        static string ClipKey(string path)
        {
            string n = path.Replace('\\', '/');
            int dot = n.LastIndexOf('.');
            int slash = n.LastIndexOf('/');
            if (dot > slash) n = n.Substring(0, dot);
            return n.ToLowerInvariant();
        }

        static string FormatTrace(List<ProcsongPulse> rows, string seedValue)
        {
            var sb = new StringBuilder();
            sb.Append("seed ").Append(seedValue).Append("  first ").Append(rows.Count).Append(" evaluations\n");
            sb.Append("  #  t       track         R_part        chosen                        R_silence     muted\n");
            for (int i = 0; i < rows.Count; i++)
            {
                var row = rows[i];
                sb.Append((i + 1).ToString().PadLeft(3));
                sb.Append("  ").Append(row.Tick.ToString().PadRight(6));
                sb.Append("  ").Append((row.Track != null ? row.Track.Name : "").PadRight(12));
                sb.Append("  ").Append(row.RPart.ToString("0.00000000").PadRight(12));
                sb.Append("  ").Append((row.Chosen ?? "(none)").PadRight(28));
                sb.Append("  ").Append(row.RSilence.ToString("0.00000000").PadRight(12));
                sb.Append("  ").Append(row.Muted ? "yes" : "no");
                sb.Append('\n');
            }
            return sb.ToString();
        }

        #region Zip

        static class Zip
        {
            public static Dictionary<string, byte[]> Read(byte[] data)
            {
                if (data == null || data.Length < 22 || data[0] != 0x50 || data[1] != 0x4b)
                    throw new ArgumentException("Package is not a zip file");

                int eocd = FindEocd(data);
                int entries = U16(data, eocd + 10);
                int cdOff = I32(data, eocd + 16);
                if (cdOff < 0 || entries == 0xFFFF)
                    throw new ArgumentException("ZIP64 packages are not supported");

                var files = new Dictionary<string, byte[]>();
                int pos = cdOff;
                for (int i = 0; i < entries; i++)
                {
                    if (U32(data, pos) != 0x02014b50u)
                        throw new ArgumentException("Invalid zip central directory");
                    int flags = U16(data, pos + 8);
                    int method = U16(data, pos + 10);
                    int comp = I32(data, pos + 20);
                    int uncomp = I32(data, pos + 24);
                    int nameLen = U16(data, pos + 28);
                    int extraLen = U16(data, pos + 30);
                    int commentLen = U16(data, pos + 32);
                    int localOff = I32(data, pos + 42);
                    string name = Encoding.UTF8.GetString(data, pos + 46, nameLen).Replace('\\', '/');
                    pos += 46 + nameLen + extraLen + commentLen;

                    if (name.EndsWith("/")) continue;
                    if (ShouldSkipPath(name)) continue;
                    if ((flags & 1) != 0)
                        throw new ArgumentException("Encrypted zip entries are not supported: " + name);
                    if (U32(data, localOff) != 0x04034b50u)
                        throw new ArgumentException("Invalid zip local header: " + name);

                    int locName = U16(data, localOff + 26);
                    int locExtra = U16(data, localOff + 28);
                    int dataStart = localOff + 30 + locName + locExtra;
                    files[name] = Inflate(data, dataStart, comp, uncomp, method);
                }
                return files;
            }

            static int FindEocd(byte[] data)
            {
                int start = data.Length - 22;
                int min = Math.Max(0, start - 65535);
                for (int i = start; i >= min; i--)
                {
                    if (data[i] == 0x50 && data[i + 1] == 0x4b && data[i + 2] == 0x05 && data[i + 3] == 0x06)
                        return i;
                }
                throw new ArgumentException("Zip end-of-central-directory not found");
            }

            static byte[] Inflate(byte[] src, int start, int comp, int uncomp, int method)
            {
                if (comp < 0 || start < 0 || start + comp > src.Length)
                    throw new ArgumentException("Invalid zip entry size");
                if (method == 0)
                {
                    var stored = new byte[uncomp > 0 ? uncomp : comp];
                    Buffer.BlockCopy(src, start, stored, 0, Math.Min(stored.Length, comp));
                    return stored;
                }
                if (method != 8)
                    throw new ArgumentException("Unsupported zip compression method " + method);

                using (var input = new MemoryStream(src, start, comp, false))
                using (var deflate = new DeflateStream(input, CompressionMode.Decompress))
                using (var output = new MemoryStream(uncomp > 0 ? uncomp : 1024))
                {
                    var buf = new byte[16384];
                    int n;
                    while ((n = deflate.Read(buf, 0, buf.Length)) > 0)
                        output.Write(buf, 0, n);
                    return output.ToArray();
                }
            }

            static int U16(byte[] d, int o) { return d[o] | (d[o + 1] << 8); }
            static int I32(byte[] d, int o) { return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24); }
            static uint U32(byte[] d, int o) { return unchecked((uint)I32(d, o)); }
        }

        #endregion

        #region WAV

        static class Wav
        {
            public static AudioClip ToAudioClip(byte[] data, string clipName)
            {
                if (data == null || data.Length < 12 || !AsciiIs(data, 0, "RIFF") || !AsciiIs(data, 8, "WAVE"))
                    throw new ArgumentException("Clip is not a PCM WAV file: " + clipName);

                int pos = 12;
                int channels = 0, sampleRate = 0, bits = 0, format = 0;
                int dataOff = -1, dataLen = 0;
                while (pos + 8 <= data.Length)
                {
                    string id = Encoding.ASCII.GetString(data, pos, 4);
                    int size = data[pos + 4] | (data[pos + 5] << 8) | (data[pos + 6] << 16) | (data[pos + 7] << 24);
                    if (size < 0) break;
                    int body = pos + 8;
                    int bodyEnd = Math.Min(body + size, data.Length);
                    if (id == "fmt " && size >= 16)
                    {
                        format = U16(data, body);
                        channels = U16(data, body + 2);
                        sampleRate = I32(data, body + 4);
                        bits = U16(data, body + 14);
                        if (format == 0xFFFE && size >= 40)
                            format = U16(data, body + 24);
                    }
                    else if (id == "data")
                    {
                        dataOff = body;
                        dataLen = Math.Min(size, data.Length - body);
                    }
                    pos = body + size;
                    if ((size & 1) != 0) pos++;
                    if (bodyEnd == data.Length) break;
                }

                if (dataOff < 0 || channels <= 0 || sampleRate <= 0 || bits <= 0)
                    throw new ArgumentException("Invalid WAV header: " + clipName);

                float[] samples = ToFloats(data, dataOff, dataLen, bits, format);
                if (samples.Length < channels)
                    throw new ArgumentException("WAV has no samples: " + clipName);
                int frames = samples.Length / channels;
                ApplyFades(samples, channels, sampleRate);
                var clip = AudioClip.Create(clipName, frames, channels, sampleRate, false);
                clip.SetData(samples, 0);
                clip.hideFlags = HideFlags.HideAndDontSave;
                return clip;
            }

            static float[] ToFloats(byte[] data, int offset, int length, int bits, int format)
            {
                int bytesPer = bits / 8;
                if (bytesPer <= 0) throw new ArgumentException("Invalid WAV bit depth " + bits);
                int count = length / bytesPer;
                var samples = new float[count];
                if (format == 3 && bits == 32)
                {
                    for (int i = 0; i < count; i++)
                        samples[i] = BitConverter.ToSingle(data, offset + i * 4);
                    return samples;
                }
                if (format != 1 && format != 0xFFFE)
                    throw new ArgumentException("Only PCM and IEEE-float WAV files are supported");

                for (int i = 0; i < count; i++)
                {
                    int o = offset + i * bytesPer;
                    switch (bits)
                    {
                        case 8:
                            samples[i] = (data[o] - 128) / 128f;
                            break;
                        case 16:
                            samples[i] = (short)(data[o] | (data[o + 1] << 8)) / 32768f;
                            break;
                        case 24:
                            int v24 = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16);
                            if ((v24 & 0x800000) != 0) v24 |= unchecked((int)0xFF000000);
                            samples[i] = v24 / 8388608f;
                            break;
                        case 32:
                            samples[i] = BitConverter.ToInt32(data, o) / 2147483648f;
                            break;
                        default:
                            throw new ArgumentException("Unsupported WAV bit depth " + bits);
                    }
                }
                return samples;
            }

            static void ApplyFades(float[] samples, int channels, int sampleRate)
            {
                int frames = samples.Length / channels;
                int fade = Math.Min(frames / 2, Math.Max(1, (int)Math.Round(FadeSec * sampleRate)));
                if (fade <= 0) return;
                bool fadeOut = frames >= fade * 2;
                for (int f = 0; f < fade; f++)
                {
                    float t = fade == 1 ? 1f : f / (float)(fade - 1);
                    float gainIn = Mathf.Sin(t * Mathf.PI * 0.5f);
                    float gainOut = Mathf.Cos(t * Mathf.PI * 0.5f);
                    for (int c = 0; c < channels; c++)
                    {
                        samples[f * channels + c] *= gainIn;
                        if (fadeOut)
                            samples[(frames - fade + f) * channels + c] *= gainOut;
                    }
                }
            }

            static bool AsciiIs(byte[] d, int o, string s)
            {
                for (int i = 0; i < s.Length; i++)
                {
                    if (d[o + i] != (byte)s[i]) return false;
                }
                return true;
            }

            static int U16(byte[] d, int o) { return d[o] | (d[o + 1] << 8); }
            static int I32(byte[] d, int o) { return d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24); }
        }

        #endregion
    }

#if UNITY_EDITOR
    [UnityEditor.CustomEditor(typeof(ProcsongPlayer))]
    sealed class ProcsongPlayerEditor : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            DrawDefaultInspector();
            UnityEditor.EditorGUILayout.Space();
            var player = (ProcsongPlayer)target;
            UnityEngine.GUI.enabled = UnityEngine.Application.isPlaying;
            UnityEditor.EditorGUILayout.BeginHorizontal();
            if (UnityEngine.GUILayout.Button(player.IsPlaying ? "Playing…" : "Play"))
                player.Play();
            if (UnityEngine.GUILayout.Button("Stop"))
                player.Stop();
            UnityEditor.EditorGUILayout.EndHorizontal();
            UnityEngine.GUI.enabled = true;
            if (!UnityEngine.Application.isPlaying)
            {
                if (serializedObject.FindProperty("songPackage").objectReferenceValue == null)
                {
                    UnityEditor.EditorGUILayout.HelpBox(
                        "Copy the procsong zip into Assets, rename it .bytes, and drag it onto Song Package.",
                        UnityEditor.MessageType.Warning);
                }
                UnityEditor.EditorGUILayout.HelpBox(
                    "Enter Play mode, then press Play on this component (or call Play() from your game). Music does not start automatically.",
                    UnityEditor.MessageType.Info);
            }
        }
    }
#endif
}
