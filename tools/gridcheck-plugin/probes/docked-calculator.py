# Read the installed Calculator layout and exercise its keypad without changing saved settings.
import blue
from eve.client.script.ui.shared.neocom.calculator import Calculator
from localization import GetByLabel

opened = Calculator.GetIfOpen()
if opened is not None:
    raise RuntimeError('Calculator must start closed')
history = settings.public.ui.Get('CalculatorHistory', [])
window = Calculator.Open()
try:
    blue.synchro.SleepWallclock(50)
    def measure(keys):
        window.OnBtnClick('clearall')
        for key in keys:
            window.OnBtnClick(key)
        return window.sr.inpt.GetValue()
    samples = {
        'precedence': measure(['2','plus','3','times','4','equal']),
        'square': measure(['9','square']),
        'root': measure(['9','root']),
        'percent': measure(['2','0','0','plus','1','0','percent','equal']),
        'decimal': measure(['0','dot','1','plus','0','dot','2','equal']),
    }
    result = {
        'title': GetByLabel('UI/Accessories/Calculator/Calculator'),
        'rect': list(window.GetAbsolute()),
        'samples': samples,
        'memoryButtons': [GetByLabel('UI/Accessories/Calculator/AbbreviatedMemory', index=index) for index in range(1, 7)],
    }
finally:
    settings.public.ui.Set('CalculatorHistory', history)
    window.Close()
