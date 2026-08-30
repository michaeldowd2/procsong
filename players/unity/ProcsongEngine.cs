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
            // Spec §6: state = (state * A + C) mod 2^64; next_float = (state >> 32) / 4294967296.0
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

    public sealed class ProcsongPart
    {
        public string Path;
        public double Weight = 1;
        /// <summary>Null means omitted (no restriction). Empty means match nothing.</summary>
        public List<string> AllowedPrimaryParts;
        public List<string> AllowedSecondaryParts;
    }

    public sealed class ProcsongTrack
    {
        public string Name;
        public int DeclIndex;
        public string Type;
        public double ProbabilitySilence;
        public int LoopSeconds;
        public int Repeats;
        public List<ProcsongPart> Parts = new List<ProcsongPart>();
    }

    public sealed class ProcsongPulse
    {
        public int Tick;
        public ProcsongTrack Track;
        public string Chosen;
        public bool Muted;
        public bool Evaluated;
        public double RPart;
        public double RSilence;
    }

    /// <summary>
    /// Deterministic scheduler. Same package + seed as the web player yields the same
    /// chosen parts, mute flags, and start times.
    /// </summary>
    public sealed class ProcsongEngine
    {
        static readonly Dictionary<string, int> Phase = new Dictionary<string, int>
        {
            { "primary", 0 },
            { "secondary", 1 },
            { "standard", 2 },
        };

        public sealed class Slot
        {
            public ProcsongTrack Track;
            public string Chosen;
            public bool Muted = true;
            public int NextLoop;
            public int Remaining;
        }

        readonly ProcsongRng _rng;
        readonly List<Slot> _state;

        public IReadOnlyList<Slot> State { get { return _state; } }

        public ProcsongEngine(IList<ProcsongTrack> tracks, ulong seed)
        {
            _rng = new ProcsongRng(seed);
            _state = new List<Slot>(tracks.Count);
            for (int i = 0; i < tracks.Count; i++)
            {
                _state.Add(new Slot
                {
                    Track = tracks[i],
                    Chosen = null,
                    Muted = true,
                    NextLoop = 0,
                    Remaining = 0,
                });
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
                SelectPart(slot.Track, pulse);
                slot.Chosen = pulse.Chosen;
                slot.Muted = pulse.Muted;
                slot.Remaining = slot.Track.Repeats;
                pulse.Evaluated = true;
            }
            else
            {
                pulse.Chosen = slot.Chosen;
                pulse.Muted = slot.Muted;
            }
            pulse.Tick = tick;
            pulse.Track = slot.Track;
            pulse.Chosen = slot.Chosen;
            pulse.Muted = slot.Muted;
            slot.Remaining -= 1;
            slot.NextLoop = tick + slot.Track.LoopSeconds;
            return pulse;
        }

        void SelectPart(ProcsongTrack track, ProcsongPulse pulse)
        {
            pulse.RPart = _rng.NextFloat();
            pulse.RSilence = _rng.NextFloat();
            var candidates = CandidatesFor(track);
            pulse.Chosen = candidates.Count > 0 ? WeightedSelect(candidates, pulse.RPart).Path : null;
            pulse.Muted = pulse.Chosen == null || pulse.RSilence < track.ProbabilitySilence;
        }

        List<string> ChosenOfType(string type)
        {
            var names = new List<string>();
            for (int i = 0; i < _state.Count; i++)
            {
                var slot = _state[i];
                if (slot.Track.Type == type && slot.Chosen != null)
                    names.Add(slot.Chosen);
            }
            return names;
        }

        List<ProcsongPart> CandidatesFor(ProcsongTrack track)
        {
            if (track.Type == "primary") return track.Parts;
            var primary = ChosenOfType("primary");
            var secondary = ChosenOfType("secondary");
            var list = new List<ProcsongPart>();
            for (int i = 0; i < track.Parts.Count; i++)
            {
                var part = track.Parts[i];
                if (track.Type == "secondary")
                {
                    if (Allows(part.AllowedPrimaryParts, primary)) list.Add(part);
                }
                else if (Allows(part.AllowedPrimaryParts, primary) && Allows(part.AllowedSecondaryParts, secondary))
                {
                    list.Add(part);
                }
            }
            return list;
        }

        static bool Allows(List<string> allowed, List<string> active)
        {
            if (allowed == null) return true;
            for (int i = 0; i < allowed.Count; i++)
            {
                if (active.Contains(allowed[i])) return true;
            }
            return false;
        }

        static ProcsongPart WeightedSelect(List<ProcsongPart> candidates, double rPart)
        {
            double total = 0;
            for (int i = 0; i < candidates.Count; i++) total += candidates[i].Weight;
            double target = rPart * total;
            double cumulative = 0;
            for (int i = 0; i < candidates.Count; i++)
            {
                cumulative += candidates[i].Weight;
                if (cumulative > target) return candidates[i];
            }
            return candidates[candidates.Count - 1];
        }

        public static int PhaseOf(string type)
        {
            int phase;
            return Phase.TryGetValue(type ?? "", out phase) ? phase : 9;
        }

        public static int AtLeastOne(double n)
        {
            if (double.IsNaN(n) || double.IsInfinity(n)) return 1;
            int value = (int)Math.Floor(n + 0.5);
            return value > 0 ? value : 1;
        }

        public static List<ProcsongTrack> ParseDefinition(string yamlText)
        {
            if (yamlText == null) throw new ArgumentException("definition.yml did not contain a track map");
            object raw = MiniYaml.Parse(yamlText);
            var root = raw as YMap;
            if (root == null) throw new ArgumentException("definition.yml did not contain a track map");

            var tracks = new List<ProcsongTrack>();
            for (int i = 0; i < root.Count; i++)
            {
                var spec = root.Values[i] as YMap;
                if (spec == null) continue;
                var track = new ProcsongTrack
                {
                    Name = root.Keys[i],
                    DeclIndex = tracks.Count,
                    Type = AsString(spec.Get("type")),
                    ProbabilitySilence = AsNumber(spec.Get("probability_silence"), 0),
                    LoopSeconds = AtLeastOne(AsNumber(spec.Get("part_duration"), double.NaN)),
                    Repeats = AtLeastOne(AsNumber(spec.Get("repeats"), double.NaN)),
                    Parts = new List<ProcsongPart>(),
                };
                var parts = spec.Get("parts") as List<object>;
                if (parts != null)
                {
                    for (int p = 0; p < parts.Count; p++)
                    {
                        var part = ParsePart(parts[p]);
                        if (part != null && !string.IsNullOrEmpty(part.Path))
                            track.Parts.Add(part);
                    }
                }
                tracks.Add(track);
            }
            if (tracks.Count == 0) throw new ArgumentException("No tracks found in definition.yml");
            tracks.Sort(delegate (ProcsongTrack a, ProcsongTrack b)
            {
                int phase = PhaseOf(a.Type) - PhaseOf(b.Type);
                return phase != 0 ? phase : a.DeclIndex - b.DeclIndex;
            });
            return tracks;
        }

        static readonly HashSet<string> PartMeta = new HashSet<string>
        {
            "weight", "allowed_primary_parts", "allowed_secondary_parts", "path"
        };

        static ProcsongPart ParsePart(object entry)
        {
            if (entry is string)
            {
                return new ProcsongPart { Path = (string)entry, Weight = 1 };
            }
            var map = entry as YMap;
            if (map == null) throw new ArgumentException("Invalid part entry");

            string path = map.Get("path") as string;
            YMap nested = null;
            for (int i = 0; i < map.Count; i++)
            {
                if (PartMeta.Contains(map.Keys[i])) continue;
                path = map.Keys[i];
                nested = map.Values[i] as YMap;
                break;
            }

            double weight = 1;
            object w = nested != null ? nested.Get("weight") : null;
            if (w == null) w = map.Get("weight");
            if (w != null) weight = AsNumber(w, 1);

            return new ProcsongPart
            {
                Path = path,
                Weight = weight,
                AllowedPrimaryParts = StringList(nested != null ? nested.Get("allowed_primary_parts") : null)
                    ?? StringList(map.Get("allowed_primary_parts")),
                AllowedSecondaryParts = StringList(nested != null ? nested.Get("allowed_secondary_parts") : null)
                    ?? StringList(map.Get("allowed_secondary_parts")),
            };
        }

        static List<string> StringList(object node)
        {
            if (node == null) return null;
            var list = node as List<object>;
            if (list == null) return new List<string>();
            var names = new List<string>(list.Count);
            for (int i = 0; i < list.Count; i++)
            {
                if (list[i] != null) names.Add(Convert.ToString(list[i], CultureInfo.InvariantCulture));
            }
            return names;
        }

        static string AsString(object node)
        {
            return node == null ? null : Convert.ToString(node, CultureInfo.InvariantCulture);
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
                            if (TrySplitEntry(rest, out key, out val))
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
