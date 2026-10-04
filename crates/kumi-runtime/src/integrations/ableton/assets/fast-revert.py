def why(error):
    if isinstance(error, KeyError): return "Live's references changed since Kumi read them; discover again"
    if isinstance(error, (TypeError, RuntimeError)): return "that device isn't in Live any more; discover it again"
    return type(error).__name__ + ': ' + str(error)[:200]
def find(t):
    try:
        p = bridge.refs.get(t['ref']) if t.get('ref') else list(bridge.refs.get(t['device']).parameters)[t['index']]
        name = str(p.name)
    except IndexError: raise LookupError('the device changed: it has fewer parameters now')
    except Exception as error: raise LookupError(why(error))
    if not t.get('ref') and name != t['name']: raise ValueError('the device changed: its parameter ' + str(t['index']) + ' is now ' + name)
    return p
def same(a, b): return abs(a - b) <= 1e-6 * max(1.0, abs(a), abs(b))
back, moved, gone = 0, [], []
for t in reversed(ARGS):
    try: p = find(t)
    except Exception:
        gone.append(t.get('name') or 'a parameter')
        continue
    if not same(float(p.value), float(t['applied'])):
        moved.append(str(p.name))
        continue
    p.value = t['prior']
    back += 1
result = {'back': back, 'moved': moved, 'gone': gone}