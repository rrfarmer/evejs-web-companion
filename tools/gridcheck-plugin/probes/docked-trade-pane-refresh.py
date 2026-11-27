"""Measure the installed client's role gate and refresh of one live trade pane."""
from types import FunctionType

import blue
from carbon.common.script.sys.serviceConst import ROLE_GML, ROLE_WORLDMOD
from carbonui.control.window import Window
from eve.client.script.ui.shared.container import GetContainerMenu
from utillib import KeyVal

window = Window.GetIfOpen(windowID='tradeWnd')
if window is None or window.tradeSession is None:
    raise RuntimeError('Open a trade with at least one item on each side first')

target, other = window.sr.my, window.sr.her
refresh_path = 'UI/Commands/Refresh'


def labels(menu):
    return [entry.GetLabelPath() for entry in menu if entry is not None]


def selected(pane):
    return sorted(node.item.itemID for node in pane.scroll.GetSelected() if node.item)


roles = {}
for name, role in (('player', 0), ('gml', ROLE_GML), ('worldmod', ROLE_WORLDMOD)):
    projected = FunctionType(GetContainerMenu.__code__, dict(GetContainerMenu.__globals__, session=KeyVal(role=role)))
    roles[name] = labels(projected(target))

refresh = next((entry for entry in target.GetContainerMenu() if entry is not None and entry.GetLabelPath() == refresh_path), None)
if refresh is None:
    raise RuntimeError('The live pilot does not have Refresh')
target.SelectAll()
other.SelectAll()
before = [selected(target), selected(other)]
if not all(before):
    raise RuntimeError('Offer an item on both sides')

reads = []
controller = target.invController
get_items = controller.GetItems


def read_items():
    items = get_items()
    reads.append(sorted(item.itemID for item in items))
    return items


controller.GetItems = read_items
try:
    refresh.func()
    for _ in xrange(40):
        if reads and not target.refreshingView and not selected(target):
            break
        blue.synchro.SleepWallclock(100)
finally:
    del controller.GetItems

result = {'pilot': session.charid, 'container': window.tradeSession.List().tradeContainerID,
          'station': session.stationid, 'roles': roles, 'label': refresh.GetText(), 'reads': reads,
          'before': before, 'after': [selected(target), selected(other)]}
