using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using System.Text;

namespace Procsong
{
    /// <summary>
    /// 64-bit LCG from the Procsong specification. Do not use UnityEngine.Random.
    /// </summary>
    public sealed class ProcsongRng
    {
        const ulong A = 6364136223846793005UL;
        const ulong C = 1442695040888963407UL;

        ulong _state;

        public ProcsongRng(ulong seed)
        {
            _state = seed;
        }

        public double NextFloat()
        {
            // Spec §14: state = (state * A + C) mod 2^64; next_float = (state >> 32) / 4294967296.0
            _state = unchecked(_state * A + C);
            return (double)(uint)(_state >> 32) / 4294967296.0;
        }

        public static ulong ParseSeed(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return 12345UL;
            BigInteger n;
            if (!BigInteger.TryParse(text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out n))
                throw new ArgumentException("Seed must be an integer");
            return unchecked((ulong)(n & ulong.MaxValue));
        }
    }

    public sealed class ProcsongClip
    {
        public string Id;
        public string Path;
        public double Weight = 1;
    }

    public sealed class ProcsongMatrix
    {
        public List<string> Columns = new List<string>();
        public Dictionary<string, double[]> Rows = new Dictionary<string, double[]>();
    }

    public sealed class ProcsongTrack
    {
        public string Name;
        public int DeclIndex;
        public double SilenceProbability;
        public int LoopSeconds;
        public int Repeats;
        public List<ProcsongClip> Clips = new List<ProcsongClip>();
        public ProcsongMatrix Intra;
        public ProcsongMatrix Inter;
    }

    public sealed class ProcsongPulse
    {
        public int Tick;
        public ProcsongTrack Track;
        public string ChosenId;
        public string Chosen;
        public bool Muted;
        public bool Evaluated;
        public double RPart;
        public double RSilence;
    }

    /// <summary>
    /// Deterministic v2 scheduler. Same package + seed as the web player yields the same
    /// chosen clips, mute flags, and start times.
    /// </summary>
    public sealed class ProcsongEngine
    {
        const string FormatVersion = "2.0.0";

        public sealed class Slot
        {
            public ProcsongTrack Track;
            public string ChosenId;
            public string Chosen;
            public bool Muted = true;
            public int NextLoop;
            public int Remaining;
            public Dictionary<string, int> IntraColIndex;
            public Dictionary<string, int> InterColIndex;
            public List<Slot> InterRepresented = new List<Slot>();
        }

        readonly ProcsongRng _rng;
        readonly List<Slot> _state;

        public IReadOnlyList<Slot> State { get { return _state; } }

        public ProcsongEngine(IList<ProcsongTrack> tracks, ulong seed)
        {
            _rng = new ProcsongRng(seed);
            var clipOwnerIndex = new Dictionary<string, int>();
            for (int t = 0; t < tracks.Count; t++)
            {
                var clips = tracks[t].Clips;
                for (int c = 0; c < clips.Count; c++)
                    clipOwnerIndex[clips[c].Id] = tracks[t].DeclIndex;
            }

            _state = new List<Slot>(tracks.Count);
            for (int i = 0; i < tracks.Count; i++)
            {
                var track = tracks[i];
                _state.Add(new Slot
                {
                    Track = track,
                    ChosenId = null,
                    Chosen = null,
                    Muted = true,
                    NextLoop = 0,
                    Remaining = 0,
                    IntraColIndex = IndexColumns(track.Intra),
                    InterColIndex = IndexColumns(track.Inter),
                });
            }

            for (int i = 0; i < _state.Count; i++)
            {
                var slot = _state[i];
                var inter = slot.Track.Inter;
                if (inter == null) continue;
                var seen = new HashSet<int>();
                for (int c = 0; c < inter.Columns.Count; c++)
                {
                    int ownerIndex;
                    if (!clipOwnerIndex.TryGetValue(inter.Columns[c], out ownerIndex)) continue;
                    if (!seen.Add(ownerIndex)) continue;
                    slot.InterRepresented.Add(_state[ownerIndex]);
                }
            }
        }

        public int PeekNextTick()
        {
            int min = int.MaxValue;
            for (int i = 0; i < _state.Count; i++)
            {
                if (_state[i].NextLoop < min) min = _state[i].NextLoop;
            }
            return min;
        }

        public List<ProcsongPulse> EvaluateDue(int tick)
        {
            var results = new List<ProcsongPulse>();
            for (int i = 0; i < _state.Count; i++)
            {
                if (_state[i].NextLoop == tick)
                    results.Add(Pulse(_state[i], tick));
            }
            return results;
        }

        public List<ProcsongPulse> Trace(int limit)
        {
            var rows = new List<ProcsongPulse>();
            for (int step = 0; rows.Count < limit && step < 100000; step++)
            {
                int tick = PeekNextTick();
                var due = EvaluateDue(tick);
                if (due.Count == 0) break;
                for (int i = 0; i < due.Count; i++)
                {
                    if (!due[i].Evaluated) continue;
                    rows.Add(due[i]);
                    if (rows.Count >= limit) break;
                }
            }
            return rows;
        }

        ProcsongPulse Pulse(Slot slot, int tick)
        {
            var pulse = new ProcsongPulse();
            if (slot.Remaining <= 0)
            {
                Evaluate(slot, pulse);
                slot.ChosenId = pulse.ChosenId;
                slot.Chosen = pulse.Chosen;
                slot.Muted = pulse.Muted;
                slot.Remaining = slot.Track.Repeats;
                pulse.Evaluated = true;
            }
            pulse.Tick = tick;
            pulse.Track = slot.Track;
            pulse.ChosenId = slot.ChosenId;
            pulse.Chosen = slot.Chosen;
            pulse.Muted = slot.Muted;
            slot.Remaining -= 1;
            slot.NextLoop = tick + slot.Track.LoopSeconds;
            return pulse;
        }

        // Spec §10.1 — previous selection in this group weights this group's next candidates.
        static double GetIntraModifier(Slot slot, ProcsongClip clip)
        {
            if (slot.ChosenId == null) return 1;
            var intra = slot.Track.Intra;
            if (intra == null) return 1;
            int col = slot.IntraColIndex[clip.Id];
            return intra.Rows[slot.ChosenId][col];
        }

        // Spec §10.2 — other groups' current selections weight this group's current candidates.
        static double GetInterModifier(Slot slot, ProcsongClip clip)
        {
            var inter = slot.Track.Inter;
            if (inter == null) return 1;
            double[] row = inter.Rows[clip.Id];
            double result = 1;
            for (int i = 0; i < slot.InterRepresented.Count; i++)
            {
                var upstream = slot.InterRepresented[i];
                if (upstream.ChosenId == null) continue;
                int col = slot.InterColIndex[upstream.ChosenId];
                result *= row[col];
            }
            return result;
        }

        // Spec §9, §11 — exactly two draws; walk clips in declaration order.
        void Evaluate(Slot slot, ProcsongPulse pulse)
        {
            pulse.RPart = _rng.NextFloat();
            pulse.RSilence = _rng.NextFloat();

            var clips = slot.Track.Clips;
            var weights = new double[clips.Count];
            double total = 0;
            for (int i = 0; i < clips.Count; i++)
            {
                var clip = clips[i];
                double w = clip.Weight * GetIntraModifier(slot, clip) * GetInterModifier(slot, clip);
                weights[i] = w;
                total += w;
            }

            if (total > 0)
            {
                double target = pulse.RPart * total;
                double running = 0;
                for (int i = 0; i < clips.Count; i++)
                {
                    running += weights[i];
                    if (running > target)
                    {
                        pulse.ChosenId = clips[i].Id;
                        pulse.Chosen = clips[i].Path;
                        break;
                    }
                }
            }

            pulse.Muted = pulse.Chosen == null || pulse.RSilence < slot.Track.SilenceProbability;
        }

        public static int AtLeastOne(double n)
        {
            if (double.IsNaN(n) || double.IsInfinity(n)) return 1;
            int value = (int)Math.Floor(n + 0.5);
            return value > 0 ? value : 1;
        }

        public static List<ProcsongTrack> ParseDefinition(string yamlText)
        {
            if (yamlText == null) throw new ArgumentException("definition.yml did not contain a mapping");
            object raw = MiniYaml.Parse(yamlText);
            var root = raw as YMap;
            if (root == null) throw new ArgumentException("definition.yml did not contain a mapping");

            string version = AsString(root.Get("format_version"));
            if (version != FormatVersion)
            {
                throw new ArgumentException(
                    "Unsupported format_version \"" + (version ?? "") + "\" (expected " + FormatVersion + "). " +
                    "Legacy track-map definitions are not supported.");
            }

            var trackList = root.Get("tracks") as List<object>;
            if (trackList == null || trackList.Count == 0)
                throw new ArgumentException("definition.yml must contain a non-empty tracks array");

            var tracks = new List<ProcsongTrack>(trackList.Count);
            for (int i = 0; i < trackList.Count; i++)
                tracks.Add(ParseTrack(trackList[i], i));
            ValidateDefinition(tracks);
            return tracks;
        }

        static ProcsongTrack ParseTrack(object raw, int index)
        {
            string where = "Track #" + (index + 1);
            var spec = raw as YMap;
            if (spec == null) throw new ArgumentException(where + " must be a mapping");

            string name = AsString(spec.Get("name"));
            if (string.IsNullOrEmpty(name)) throw new ArgumentException(where + " is missing a string name");
            if (name.IndexOf('/') >= 0) throw new ArgumentException("Track \"" + name + "\" name must not contain \"/\"");

            if (spec.Get("clip_length") == null)
                throw new ArgumentException("Track \"" + name + "\" is missing clip_length");
            double clipLength = AsNumber(spec.Get("clip_length"), double.NaN);
            if (double.IsNaN(clipLength) || clipLength < 0)
                throw new ArgumentException("Track \"" + name + "\" clip_length must be a non-negative number");

            int repeats = RequireIntegerAtLeast(spec.Get("repeats"), "Track \"" + name + "\" repeats");

            double silence = 0;
            if (spec.Get("silence_probability") != null)
            {
                silence = AsNumber(spec.Get("silence_probability"), double.NaN);
                if (double.IsNaN(silence) || silence < 0 || silence > 1)
                    throw new ArgumentException("Track \"" + name + "\" silence_probability must be between 0 and 1");
            }

            var clipList = spec.Get("clips") as List<object>;
            if (clipList == null || clipList.Count == 0)
                throw new ArgumentException("Track \"" + name + "\" must define a non-empty clips array");

            var clips = new List<ProcsongClip>(clipList.Count);
            for (int i = 0; i < clipList.Count; i++)
                clips.Add(ParseClip(clipList[i], name, i));

            return new ProcsongTrack
            {
                Name = name,
                DeclIndex = index,
                LoopSeconds = AtLeastOne(clipLength),
                Repeats = repeats,
                SilenceProbability = silence,
                Clips = clips,
                Intra = ParseMatrix(spec.Get("intragroup_subsequent_weight_modifiers"), name, "intragroup_subsequent_weight_modifiers"),
                Inter = ParseMatrix(spec.Get("intergroup_consecutive_weight_modifiers"), name, "intergroup_consecutive_weight_modifiers"),
            };
        }

        static ProcsongClip ParseClip(object entry, string trackName, int index)
        {
            string where = "Track \"" + trackName + "\" clip #" + (index + 1);
            if (entry is string)
            {
                throw new ArgumentException(where + " must be a mapping with id and path (legacy path-only parts are not supported)");
            }
            var map = entry as YMap;
            if (map == null) throw new ArgumentException(where + " must be a mapping with id and path");

            string id = RequireId(map.Get("id"), where + " is missing a string id");
            string path = AsString(map.Get("path"));
            if (string.IsNullOrEmpty(path)) throw new ArgumentException(where + " (" + id + ") is missing a string path");

            return new ProcsongClip
            {
                Id = id,
                Path = path,
                Weight = ParseWeight(map.Get("weight"), where + " (" + id + ") weight"),
            };
        }

        static ProcsongMatrix ParseMatrix(object raw, string trackName, string kind)
        {
            if (raw == null) return null;
            string where = "Track \"" + trackName + "\" " + kind;
            var map = raw as YMap;
            if (map == null) throw new ArgumentException(where + " must be a mapping with columns and rows");

            var colNode = map.Get("columns") as List<object>;
            if (colNode == null) throw new ArgumentException(where + " is missing a columns array");
            var rowNode = map.Get("rows") as YMap;
            if (rowNode == null) throw new ArgumentException(where + " is missing a rows mapping");

            var columns = new List<string>(colNode.Count);
            var seen = new HashSet<string>();
            for (int i = 0; i < colNode.Count; i++)
            {
                string id = RequireId(colNode[i], where + " column #" + (i + 1) + " must be a clip id string");
                if (!seen.Add(id)) throw new ArgumentException(where + " columns must be unique clip ids");
                columns.Add(id);
            }

            var rows = new Dictionary<string, double[]>();
            for (int r = 0; r < rowNode.Count; r++)
            {
                string rowKey = rowNode.Keys[r];
                var values = rowNode.Values[r] as List<object>;
                if (values == null) throw new ArgumentException(where + " row \"" + rowKey + "\" must be an array");
                var cells = new double[values.Count];
                for (int i = 0; i < values.Count; i++)
                    cells[i] = ParseWeight(values[i], where + " row \"" + rowKey + "\" cell #" + (i + 1));
                rows[rowKey] = cells;
            }

            return new ProcsongMatrix { Columns = columns, Rows = rows };
        }

        static void ValidateDefinition(List<ProcsongTrack> tracks)
        {
            var trackNames = new HashSet<string>();
            for (int i = 0; i < tracks.Count; i++)
            {
                if (!trackNames.Add(tracks[i].Name))
                    throw new ArgumentException("Track names must be unique");
            }

            var clipOwner = new Dictionary<string, ProcsongTrack>();
            for (int t = 0; t < tracks.Count; t++)
            {
                var clips = tracks[t].Clips;
                for (int c = 0; c < clips.Count; c++)
                {
                    if (clipOwner.ContainsKey(clips[c].Id))
                    {
                        throw new ArgumentException(
                            "Clip id \"" + clips[c].Id + "\" is used more than once (must be unique across the whole definition)");
                    }
                    clipOwner[clips[c].Id] = tracks[t];
                }
            }

            for (int t = 0; t < tracks.Count; t++)
            {
                var track = tracks[t];
                var clipIds = ClipIds(track);

                if (track.Intra != null)
                {
                    var m = track.Intra;
                    if (!ArraysEqual(m.Columns, clipIds))
                        throw new ArgumentException("Track \"" + track.Name + "\" intra columns must equal its clip ids in declaration order");
                    if (!SameSet(new List<string>(m.Rows.Keys), clipIds))
                        throw new ArgumentException("Track \"" + track.Name + "\" intra rows must contain exactly one row for each clip id");
                    foreach (var pair in m.Rows)
                    {
                        if (pair.Value.Length != m.Columns.Count)
                        {
                            throw new ArgumentException(
                                "Track \"" + track.Name + "\" intra row \"" + pair.Key + "\" length must equal column count (" + m.Columns.Count + ")");
                        }
                    }
                }

                if (track.Inter != null)
                {
                    var m = track.Inter;
                    if (!SameSet(new List<string>(m.Rows.Keys), clipIds))
                        throw new ArgumentException("Track \"" + track.Name + "\" inter rows must contain exactly one row for each clip id");
                    foreach (var pair in m.Rows)
                    {
                        if (pair.Value.Length != m.Columns.Count)
                        {
                            throw new ArgumentException(
                                "Track \"" + track.Name + "\" inter row \"" + pair.Key + "\" length must equal column count (" + m.Columns.Count + ")");
                        }
                    }

                    var repOrder = new List<ProcsongTrack>();
                    var seenTracks = new HashSet<int>();
                    for (int c = 0; c < m.Columns.Count; c++)
                    {
                        string col = m.Columns[c];
                        ProcsongTrack owner;
                        if (!clipOwner.TryGetValue(col, out owner))
                            throw new ArgumentException("Track \"" + track.Name + "\" inter column \"" + col + "\" is not a known clip id");
                        if (owner.DeclIndex >= track.DeclIndex)
                            throw new ArgumentException("Track \"" + track.Name + "\" inter column \"" + col + "\" references clip on the same or a later track");
                        if (seenTracks.Add(owner.DeclIndex))
                            repOrder.Add(owner);
                    }

                    for (int i = 1; i < repOrder.Count; i++)
                    {
                        if (repOrder[i].DeclIndex <= repOrder[i - 1].DeclIndex)
                            throw new ArgumentException("Track \"" + track.Name + "\" inter columns must list upstream tracks in declaration order");
                    }

                    for (int u = 0; u < repOrder.Count; u++)
                    {
                        var upstream = repOrder[u];
                        var upstreamIds = ClipIds(upstream);
                        var colsForUpstream = new List<string>();
                        for (int c = 0; c < m.Columns.Count; c++)
                        {
                            ProcsongTrack owner;
                            if (clipOwner.TryGetValue(m.Columns[c], out owner) && owner == upstream)
                                colsForUpstream.Add(m.Columns[c]);
                        }
                        if (!ArraysEqual(colsForUpstream, upstreamIds))
                        {
                            throw new ArgumentException(
                                "Track \"" + track.Name + "\" inter columns for upstream track \"" + upstream.Name +
                                "\" must be all of its clip ids in declaration order");
                        }
                    }
                }
            }
        }

        static List<string> ClipIds(ProcsongTrack track)
        {
            var ids = new List<string>(track.Clips.Count);
            for (int i = 0; i < track.Clips.Count; i++) ids.Add(track.Clips[i].Id);
            return ids;
        }

        static Dictionary<string, int> IndexColumns(ProcsongMatrix matrix)
        {
            if (matrix == null) return null;
            var map = new Dictionary<string, int>(matrix.Columns.Count);
            for (int i = 0; i < matrix.Columns.Count; i++)
                map[matrix.Columns[i]] = i;
            return map;
        }

        static bool ArraysEqual(IList<string> a, IList<string> b)
        {
            if (a.Count != b.Count) return false;
            for (int i = 0; i < a.Count; i++)
            {
                if (a[i] != b[i]) return false;
            }
            return true;
        }

        static bool SameSet(IList<string> a, IList<string> b)
        {
            if (a.Count != b.Count) return false;
            var set = new HashSet<string>(a);
            for (int i = 0; i < b.Count; i++)
            {
                if (!set.Contains(b[i])) return false;
            }
            return true;
        }

        static string RequireId(object node, string message)
        {
            if (node == null || node is bool)
                throw new ArgumentException(message);
            string id = Convert.ToString(node, CultureInfo.InvariantCulture);
            if (string.IsNullOrEmpty(id)) throw new ArgumentException(message);
            return id;
        }

        static int RequireIntegerAtLeast(object node, string context)
        {
            double n = AsNumber(node, double.NaN);
            if (double.IsNaN(n) || n < 1 || n != Math.Floor(n))
                throw new ArgumentException(context + " must be an integer >= 1");
            return (int)n;
        }

        static double ParseWeight(object node, string context)
        {
            if (node == null) return 1;
            double n = AsNumber(node, double.NaN);
            if (double.IsNaN(n) || n < 0)
                throw new ArgumentException(context + " must be a non-negative number");
            return n;
        }

        static string AsString(object node)
        {
            if (node == null || node is bool) return null;
            return Convert.ToString(node, CultureInfo.InvariantCulture);
        }

        static double AsNumber(object node, double fallback)
        {
            if (node == null) return fallback;
            if (node is double) return (double)node;
            if (node is bool) return fallback;
            double n;
            if (double.TryParse(Convert.ToString(node, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out n))
                return n;
            return fallback;
        }

        #region Minimal YAML (maps, lists, scalars — enough for definition.yml)

        sealed class YMap
        {
            public readonly List<string> Keys = new List<string>();
            public readonly List<object> Values = new List<object>();
            public int Count { get { return Keys.Count; } }
            public void Add(string key, object value)
            {
                int i = Keys.IndexOf(key);
                if (i >= 0)
                {
                    Values[i] = value;
                    return;
                }
                Keys.Add(key);
                Values.Add(value);
            }
            public object Get(string key)
            {
                int i = Keys.IndexOf(key);
                return i < 0 ? null : Values[i];
            }
        }

        struct YLine
        {
            public int Indent;
            public string Text;
        }

        static class MiniYaml
        {
            public static object Parse(string text)
            {
                var lines = Preprocess(text);
                var parser = new Parser(lines);
                object node = parser.ParseValue(0);
                return node;
            }

            static List<YLine> Preprocess(string text)
            {
                if (text.Length > 0 && text[0] == '\uFEFF') text = text.Substring(1);
                text = text.Replace("\r\n", "\n").Replace('\r', '\n');
                var lines = new List<YLine>();
                var raw = text.Split('\n');
                for (int i = 0; i < raw.Length; i++)
                {
                    string row = raw[i];
                    int pos = 0;
                    int indent = 0;
                    while (pos < row.Length)
                    {
                        if (row[pos] == ' ') { indent++; pos++; }
                        else if (row[pos] == '\t') { indent += 2; pos++; }
                        else break;
                    }
                    string body = StripComment(row.Substring(pos)).TrimEnd();
                    if (body.Length == 0 || body == "---" || body == "...") continue;
                    lines.Add(new YLine { Indent = indent, Text = body });
                }
                return lines;
            }

            static string StripComment(string s)
            {
                bool inQuote = false;
                char q = '\0';
                for (int i = 0; i < s.Length; i++)
                {
                    char c = s[i];
                    if (inQuote)
                    {
                        if (c == '\\' && q == '"' && i + 1 < s.Length) { i++; continue; }
                        if (c == q) inQuote = false;
                    }
                    else if (c == '"' || c == '\'')
                    {
                        inQuote = true;
                        q = c;
                    }
                    else if (c == '#' && (i == 0 || s[i - 1] == ' '))
                    {
                        return s.Substring(0, i).TrimEnd();
                    }
                }
                return s;
            }

            sealed class Parser
            {
                readonly List<YLine> _lines;
                int _i;

                public Parser(List<YLine> lines) { _lines = lines; }

                public object ParseValue(int minIndent)
                {
                    if (_i >= _lines.Count) return null;
                    int indent = _lines[_i].Indent;
                    if (indent < minIndent) return null;
                    if (IsListItem(_lines[_i].Text)) return ParseList(indent);
                    string key, val;
                    if (TrySplitEntry(_lines[_i].Text, out key, out val)) return ParseMap(indent, null);
                    object scalar = ParseScalar(_lines[_i].Text);
                    _i++;
                    return scalar;
                }

                object ParseMap(int indent, string injected)
                {
                    var map = new YMap();
                    bool useInjected = injected != null;
                    while (true)
                    {
                        string text;
                        if (useInjected)
                        {
                            useInjected = false;
                            text = injected;
                        }
                        else
                        {
                            if (_i >= _lines.Count) break;
                            if (_lines[_i].Indent < indent) break;
                            if (_lines[_i].Indent > indent) break;
                            if (IsListItem(_lines[_i].Text)) break;
                            text = _lines[_i].Text;
                            _i++;
                        }

                        string key, val;
                        if (!TrySplitEntry(text, out key, out val))
                            throw new ArgumentException("Invalid YAML mapping line: " + text);

                        object parsed;
                        if (val.Length == 0)
                        {
                            if (_i < _lines.Count)
                            {
                                int next = _lines[_i].Indent;
                                if (next > indent || (next == indent && IsListItem(_lines[_i].Text)))
                                    parsed = ParseValue(next > indent ? indent + 1 : indent);
                                else
                                    parsed = null;
                            }
                            else parsed = null;
                        }
                        else
                        {
                            parsed = ParseInline(val);
                        }
                        map.Add(key, parsed);
                    }
                    return map;
                }

                object ParseList(int indent)
                {
                    var list = new List<object>();
                    while (_i < _lines.Count)
                    {
                        if (_lines[_i].Indent != indent) break;
                        if (!IsListItem(_lines[_i].Text)) break;
                        string rest = ListItemRest(_lines[_i].Text);
                        _i++;
                        if (rest.Length == 0)
                        {
                            list.Add(ParseValue(indent + 1));
                        }
                        else
                        {
                            string key, val;
                            if (rest[0] == '{' || rest[0] == '[')
                                list.Add(ParseInline(rest));
                            else if (TrySplitEntry(rest, out key, out val))
                                list.Add(ParseMap(indent + 2, rest));
                            else
                                list.Add(ParseInline(rest));
                        }
                    }
                    return list;
                }

                static bool IsListItem(string text)
                {
                    return text == "-" || text.StartsWith("- ");
                }

                static string ListItemRest(string text)
                {
                    if (text == "-") return "";
                    return text.Substring(2);
                }
            }

            static bool TrySplitEntry(string text, out string key, out string value)
            {
                int colon = -1;
                bool inQuote = false;
                char q = '\0';
                for (int i = 0; i < text.Length; i++)
                {
                    char c = text[i];
                    if (inQuote)
                    {
                        if (c == '\\' && q == '"' && i + 1 < text.Length) { i++; continue; }
                        if (c == q) inQuote = false;
                        continue;
                    }
                    if (c == '"' || c == '\'') { inQuote = true; q = c; continue; }
                    if (c == ':' && (i + 1 >= text.Length || text[i + 1] == ' '))
                    {
                        colon = i;
                        break;
                    }
                }
                if (colon <= 0)
                {
                    key = null;
                    value = null;
                    return false;
                }
                key = Unquote(text.Substring(0, colon).Trim());
                value = colon + 1 < text.Length ? text.Substring(colon + 1).Trim() : "";
                return key.Length > 0;
            }

            static object ParseInline(string text)
            {
                if (text.Length == 0) return null;
                if (text[0] == '[') return ParseInlineList(text);
                if (text[0] == '{') return ParseInlineMap(text);
                return ParseScalar(text);
            }

            static object ParseInlineList(string text)
            {
                var list = new List<object>();
                if (text == "[]") return list;
                if (text.Length < 2 || text[text.Length - 1] != ']')
                    return ParseScalar(text);
                var items = SplitComma(text.Substring(1, text.Length - 2));
                for (int i = 0; i < items.Count; i++)
                {
                    string item = items[i].Trim();
                    if (item.Length > 0) list.Add(ParseScalar(item));
                }
                return list;
            }

            static object ParseInlineMap(string text)
            {
                var map = new YMap();
                if (text == "{}") return map;
                if (text.Length < 2 || text[text.Length - 1] != '}')
                    return ParseScalar(text);
                var items = SplitComma(text.Substring(1, text.Length - 2));
                for (int i = 0; i < items.Count; i++)
                {
                    string key, val;
                    if (TrySplitEntry(items[i].Trim(), out key, out val))
                        map.Add(key, ParseScalar(val));
                }
                return map;
            }

            static List<string> SplitComma(string text)
            {
                var items = new List<string>();
                var buf = new StringBuilder();
                bool inQuote = false;
                char q = '\0';
                int depth = 0;
                for (int i = 0; i < text.Length; i++)
                {
                    char c = text[i];
                    if (inQuote)
                    {
                        buf.Append(c);
                        if (c == '\\' && q == '"' && i + 1 < text.Length) { buf.Append(text[++i]); continue; }
                        if (c == q) inQuote = false;
                        continue;
                    }
                    if (c == '"' || c == '\'') { inQuote = true; q = c; buf.Append(c); continue; }
                    if (c == '[' || c == '{') { depth++; buf.Append(c); continue; }
                    if (c == ']' || c == '}') { depth--; buf.Append(c); continue; }
                    if (c == ',' && depth == 0)
                    {
                        items.Add(buf.ToString());
                        buf.Length = 0;
                        continue;
                    }
                    buf.Append(c);
                }
                if (buf.Length > 0) items.Add(buf.ToString());
                return items;
            }

            static object ParseScalar(string s)
            {
                if (s == "~" || s == "null" || s == "Null" || s == "NULL") return null;
                if (s == "true" || s == "True" || s == "TRUE") return true;
                if (s == "false" || s == "False" || s == "FALSE") return false;
                if (s.Length >= 2 && ((s[0] == '"' && s[s.Length - 1] == '"') || (s[0] == '\'' && s[s.Length - 1] == '\'')))
                    return Unescape(s.Substring(1, s.Length - 2), s[0]);
                if (LooksNumeric(s))
                {
                    double n;
                    if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out n))
                        return n;
                }
                return s;
            }

            static bool LooksNumeric(string s)
            {
                if (s.Length == 0) return false;
                int i = 0;
                if (s[0] == '+' || s[0] == '-') i++;
                if (i >= s.Length) return false;
                bool digit = false, dot = false, exp = false;
                for (; i < s.Length; i++)
                {
                    char c = s[i];
                    if (c >= '0' && c <= '9') { digit = true; continue; }
                    if (c == '.' && !dot && !exp) { dot = true; continue; }
                    if ((c == 'e' || c == 'E') && digit && !exp)
                    {
                        exp = true;
                        digit = false;
                        if (i + 1 < s.Length && (s[i + 1] == '+' || s[i + 1] == '-')) i++;
                        continue;
                    }
                    return false;
                }
                return digit;
            }

            static string Unquote(string s)
            {
                if (s.Length >= 2 && ((s[0] == '"' && s[s.Length - 1] == '"') || (s[0] == '\'' && s[s.Length - 1] == '\'')))
                    return Unescape(s.Substring(1, s.Length - 2), s[0]);
                return s;
            }

            static string Unescape(string s, char quote)
            {
                if (quote == '\'') return s.Replace("''", "'");
                var buf = new StringBuilder(s.Length);
                for (int i = 0; i < s.Length; i++)
                {
                    if (s[i] == '\\' && i + 1 < s.Length)
                    {
                        char n = s[++i];
                        if (n == 'n') buf.Append('\n');
                        else if (n == 't') buf.Append('\t');
                        else if (n == 'r') buf.Append('\r');
                        else buf.Append(n);
                    }
                    else buf.Append(s[i]);
                }
                return buf.ToString();
            }
        }

        #endregion
    }
}
