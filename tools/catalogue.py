#!/usr/bin/env python3
"""Rebuild the ManGrenade stock and the Gallery small works in index.html from data/catalogue.json.

Each item has a status:
  stall  shown with its price; no Buy (held for the festival stall)
  live   shown with a Buy tag (needs "link": a Stripe payment link)
  sold   shown greyed out with a SOLD stamp

Run from the repo root:  python3 tools/catalogue.py
"""
import html, json, re

DATA = 'data/catalogue.json'
PAGE = 'index.html'


def tag(item):
    if item['status'] == 'sold':
        return '<span class="sold-stamp label">Sold</span>'
    if item['status'] == 'live' and item.get('link', '').startswith('https://buy.stripe.com/'):
        return f'<a class="buy tag label" href="{html.escape(item["link"])}">Buy now</a>'
    return ''


def mg_card(c):
    sold = ' is-sold' if c['status'] == 'sold' else ''
    return (f'<article class="mg{sold}" data-price="{c["price"]}" data-code="{c["code"]}">'
            f'<img src="{c["img"]}" width="480" height="640" alt="ManGrenade No. {c["no"]}" loading="lazy">'
            f'<div class="mg-row"><h3>No. {c["no"]}</h3><span class="price">&pound;{c["price"]}</span></div>{tag(c)}</article>')


def art_card(a):
    sold = ' is-sold' if a['status'] == 'sold' else ''
    img = (f'<img src="{a["img"]}" alt="{html.escape(a["title"])}, {a["code"]}" loading="lazy">' if a.get('img') else '')
    return (f'<article class="sw{sold}" data-code="{a["code"]}">{img}'
            f'<div class="sw-row"><h3>{html.escape(a["title"])}</h3><span class="price">&pound;{a["price"]}</span></div>'
            f'<span class="code label">{a["code"]}</span>{tag(a)}</article>')


def swap(page, name, inner):
    pat = re.compile(r'(<!-- CATALOGUE:%s -->).*?(<!-- /CATALOGUE:%s -->)' % (name, name), re.S)
    assert pat.search(page), name
    return pat.sub(lambda m: m.group(1) + '\n' + inner + '\n' + m.group(2), page)


def main():
    d = json.load(open(DATA))
    mg = d['mangrenades']
    art = [a for a in d['art'] if not a['code'].startswith('LE-')]
    left = sum(1 for c in mg if c['status'] != 'sold')
    prices = sorted({c['price'] for c in mg})
    chips = '<button type="button" data-f="all" aria-pressed="true">All</button>' + ''.join(
        f'<button type="button" data-f="{p}" aria-pressed="false">&pound;{p}</button>' for p in prices)
    mg_html = (f'<div class="mg-tools" role="group" aria-label="Filter by price">{chips}</div>\n'
               f'<div class="mg-grid" id="mg-grid">\n' + '\n'.join(mg_card(c) for c in mg) + '\n</div>')
    art_html = '<div class="sw-grid">\n' + '\n'.join(art_card(a) for a in art) + '\n</div>'
    page = open(PAGE).read()
    page = swap(page, 'MG', mg_html)
    page = swap(page, 'ART', art_html)
    page = re.sub(r'(<span class="when-closed">See all )\d+( ManGrenades</span>|( ManGrenades))', lambda m: m.group(1) + str(left) + ' ManGrenades</span>' if m.group(2).endswith('</span>') else m.group(0), page)
    page = re.sub(r'<small class="when-closed">See all \d+ ManGrenades</small>', f'<small class="when-closed">See all {left} ManGrenades</small>', page)
    page = re.sub(r'(<span class="mg-count">)\d+(</span>)', lambda m: m.group(1) + str(left) + m.group(2), page)
    open(PAGE, 'w').write(page)
    print(f'{len(mg)} ManGrenades ({left} unsold), {len(art)} small works')


if __name__ == '__main__':
    main()
