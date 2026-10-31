"""Check a download-items.js output dir: index vs meta vs files on disk.

Usage: python3 verify.py [outDir]   (default: out)
Run it from the output dir's parent, or pass the dir explicitly.
Reports mismatches, zero-image items, empty descriptions and status counts.
"unknown" status is reported separately: it must not be counted as on_sale.
"""
import json, glob, os, sys, collections

out = sys.argv[1] if len(sys.argv) > 1 else "out"
idx = json.load(open(os.path.join(out, "index.json")))
print("index items", len(idx), "total downloaded", sum(x["downloaded"] for x in idx))
print("status", collections.Counter(x.get("status") for x in idx))
print("mismatch downloaded!=imageCount:", [(x["itemId"], x["imageCount"], x["downloaded"]) for x in idx if x["downloaded"] != x["imageCount"]])
descs = []
for x in idx:
    iid = x["itemId"]
    m = json.load(open(os.path.join(out, "items", iid, "meta.json")))
    descs.append((iid, len(m.get("description", "")), m.get("title", "")[:20]))
    files = sorted(glob.glob(os.path.join(out, "items", iid, "*.jpg")))
    if len(files) != x["downloaded"]:
        print("FILE COUNT MISMATCH", iid, len(files), x["downloaded"])
print("empty description:", [d for d in descs if d[1] == 0])
print("zero image items:", [(x["itemId"], x["title"]) for x in idx if x["downloaded"] == 0])
print("shortest descriptions:", sorted(descs, key=lambda t: t[1])[:5])
