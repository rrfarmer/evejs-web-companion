# Observe the installed client's Market Orders command and restore window state.
from eve.client.script.ui.shared.market.marketbase import RegionalMarket
from eve.client.script.ui.shared.market.marketOrdersWnd import MarketOrdersWnd

before = MarketOrdersWnd.GetIfOpen()
regional_before = RegionalMarket.GetIfOpen()
if before is not None:
    raise RuntimeError('Market Orders must start closed in the reference fixture')
try:
    MarketOrdersWnd.ToggleOpenClose()
    window = MarketOrdersWnd.GetIfOpen()
    if window is None:
        raise RuntimeError('Market Orders did not open')
    observation = {
        'windowID': window.default_windowID,
        'size': [window.default_width, window.default_height],
        'minimum': list(window.default_minSize),
        'personal': type(window.personalOrders).__name__,
        'history': type(window.marketHistory).__name__,
        'corp': window.corpOrders is not None,
        'independent': RegionalMarket.GetIfOpen() is regional_before,
        'selected': window.tabGroup.GetSelectedID(),
    }
    MarketOrdersWnd.ToggleOpenClose()
    observation['commandClosed'] = MarketOrdersWnd.GetIfOpen() is None
    result = observation
finally:
    opened = MarketOrdersWnd.GetIfOpen()
    if opened is not None:
        opened.Close()
