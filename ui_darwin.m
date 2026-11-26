// macOS 桌面界面：主控制台窗口 + 菜单栏图标 + 菜单栏小窗（点图标在下方弹出，失焦自动收起，图钉固定后常驻置顶）。
// 窗口、菜单栏图标和两个 WKWebView 都在主线程上，由 NSApplication 的事件循环驱动。

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#include "_cgo_export.h"

enum { kMain = 0, kMini = 1 };
static const CGFloat kMainW = 1320, kMainH = 820, kMainMinW = 720, kMainMinH = 520;
static const CGFloat kMiniW = 400, kMiniH = 486;
static NSString *const kFrameName = @"gamMain";
static NSString *const kAppName = @"谷歌账号管理";

static void showMain(void);
static void closeMain(void);
static void showMini(void);
static void hideMini(void);
static void toggleMini(void);

static void gamLogf(NSString *fmt, ...) NS_FORMAT_FUNCTION(1, 2);
static void gamLogf(NSString *fmt, ...) {
	va_list ap;
	va_start(ap, fmt);
	NSString *s = [[NSString alloc] initWithFormat:fmt arguments:ap];
	va_end(ap);
	goGamLog((char *)s.UTF8String);
}

// 无边框面板默认不能成为 key 窗口，小窗里要能输入和接收 Esc。
@interface GamPanel : NSPanel
@end

@implementation GamPanel
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return NO; }
- (void)performClose:(id)sender { hideMini(); } // ⌘W 收起小窗
@end

// 脚本消息处理器单独一个对象：WKUserContentController 会强引用它。
@interface GamScriptHandler : NSObject <WKScriptMessageHandler>
@property(nonatomic) int tag;
@end

@interface GamController : NSObject <NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate>
@end

static NSString *gPageURL;
static BOOL gRunning, gDevtools, gLightweight, gPinned;
static int gModal;                  // 正在显示网页触发的弹框：期间小窗不因失焦收起
static BOOL gCloseAfterFullScreen;  // 全屏时点关闭：先退出全屏再收起
static NSWindow *gMain;
static WKWebView *gMainView;
static GamPanel *gMini;
static WKWebView *gMiniView;
static NSStatusItem *gStatus;
static NSMenu *gStatusMenu;
static id gClickMonitor;
static NSTimeInterval gMiniHiddenAt = -1;
static GamController *gCtl;

static NSTimeInterval now(void) { return NSProcessInfo.processInfo.systemUptime; }

static void loadPrefs(void) {
	int lw = 0, pin = 0;
	goGamLoadPrefs(&lw, &pin);
	gLightweight = lw != 0;
	gPinned = pin != 0;
}

static void activateApp(void) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
	[NSApp activateIgnoringOtherApps:YES];
#pragma clang diagnostic pop
	if (@available(macOS 14.0, *)) [NSApp activate];
}

static BOOL isLocalURL(NSURL *u) {
	NSString *scheme = u.scheme.lowercaseString;
	if ([scheme isEqualToString:@"about"] || [scheme isEqualToString:@"blob"] || [scheme isEqualToString:@"data"]) return YES;
	if (![scheme isEqualToString:@"http"] && ![scheme isEqualToString:@"https"]) return NO;
	NSString *host = u.host.lowercaseString;
	NSString *own = [NSURL URLWithString:gPageURL].host.lowercaseString;
	return [host isEqualToString:own] || [host isEqualToString:@"127.0.0.1"] || [host isEqualToString:@"localhost"] || [host isEqualToString:@"::1"];
}

static WKWebView *makeWebView(int tag, NSRect frame) {
	WKUserContentController *ucc = [WKUserContentController new];
	GamScriptHandler *h = [GamScriptHandler new];
	h.tag = tag;
	[ucc addScriptMessageHandler:h name:@"gam"];
	[ucc addUserScript:[[WKUserScript alloc] initWithSource:@"window.gamShell=\"mac\";"
	                                          injectionTime:WKUserScriptInjectionTimeAtDocumentStart
	                                       forMainFrameOnly:YES]];
	WKWebViewConfiguration *cfg = [WKWebViewConfiguration new];
	cfg.userContentController = ucc;
	if (gDevtools) [cfg.preferences setValue:@YES forKey:@"developerExtrasEnabled"];

	WKWebView *v = [[WKWebView alloc] initWithFrame:frame configuration:cfg];
	[v setValue:@NO forKey:@"drawsBackground"]; // 透出窗口底色，避免加载时白屏闪一下
	if (@available(macOS 12.0, *)) v.underPageBackgroundColor = NSColor.windowBackgroundColor;
	if (@available(macOS 13.3, *)) v.inspectable = gDevtools;
	v.allowsBackForwardNavigationGestures = NO;
	v.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
	v.navigationDelegate = gCtl;
	v.UIDelegate = gCtl;
	NSString *page = [gPageURL stringByAppendingString:tag == kMini ? @"mini.html?shell=mac" : @"?shell=mac"];
	[v loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:page]]];
	return v;
}

static void releaseWebView(WKWebView *v) {
	WKUserContentController *ucc = v.configuration.userContentController;
	[ucc removeScriptMessageHandlerForName:@"gam"];
	[ucc removeAllUserScripts];
	v.navigationDelegate = nil;
	v.UIDelegate = nil;
	[v stopLoading];
	[v removeFromSuperview];
}

// ---------- 主控制台 ----------

static void createMain(void) {
	NSTimeInterval start = now();
	NSRect vis = (NSScreen.mainScreen ?: NSScreen.screens.firstObject).visibleFrame;
	CGFloat w = MIN(kMainW, vis.size.width), h = MIN(kMainH, vis.size.height);
	NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable |
	                          NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView;
	NSWindow *win = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, w, h) styleMask:style backing:NSBackingStoreBuffered defer:NO];
	win.releasedWhenClosed = NO;
	win.title = kAppName;
	win.titlebarAppearsTransparent = YES;
	win.titleVisibility = NSWindowTitleHidden; // 网页顶栏左侧给红绿灯留了位置（?shell=mac）
	win.backgroundColor = NSColor.windowBackgroundColor;
	win.contentMinSize = NSMakeSize(MIN(kMainMinW, w), MIN(kMainMinH, h));
	win.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
	win.tabbingMode = NSWindowTabbingModeDisallowed;
	[win center];
	[win setFrameUsingName:kFrameName]; // 有保存过的位置大小就恢复
	[win setFrameAutosaveName:kFrameName];

	WKWebView *v = makeWebView(kMain, win.contentView.bounds);
	win.contentView = v;
	win.initialFirstResponder = v;
	win.delegate = gCtl;
	gMain = win;
	gMainView = v;
	gamLogf(@"主控制台创建完成，用时 %.0fms", (now() - start) * 1000);
}

// destroyMain：轻量模式下关窗连 WKWebView 一起释放，下次打开重新创建。
static void destroyMain(void) {
	NSWindow *w = gMain;
	WKWebView *v = gMainView;
	gMain = nil;
	gMainView = nil;
	if (!w) return;
	[w saveFrameUsingName:kFrameName];
	[w setFrameAutosaveName:@""]; // 释放名字，重建的窗口才能再用
	w.delegate = nil;
	releaseWebView(v);
	[w orderOut:nil];
	[w close];
}

static void showMain(void) {
	if (!gMain) createMain();
	if (gMain.miniaturized) [gMain deminiaturize:nil];
	activateApp();
	[gMain makeKeyAndOrderFront:nil];
	[gMain orderFrontRegardless];
}

// closeMain：关窗只是收到菜单栏，程序继续运行；轻量模式下销毁窗口释放内存。
static void closeMain(void) {
	if (!gMain) return;
	if (gMain.styleMask & NSWindowStyleMaskFullScreen) {
		gCloseAfterFullScreen = YES; // 全屏窗口直接隐藏会留下黑屏的空间
		[gMain toggleFullScreen:nil];
		return;
	}
	if (!gLightweight) {
		[gMain orderOut:nil];
		return;
	}
	dispatch_async(dispatch_get_main_queue(), ^{ destroyMain(); }); // 不在 windowShouldClose 回调里直接关
}

// ---------- 菜单栏小窗 ----------

static void createMini(void) {
	NSTimeInterval start = now();
	GamPanel *p = [[GamPanel alloc] initWithContentRect:NSMakeRect(0, 0, kMiniW, kMiniH)
	                                          styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
	                                            backing:NSBackingStoreBuffered
	                                              defer:NO];
	p.releasedWhenClosed = NO;
	p.opaque = NO;
	p.backgroundColor = NSColor.clearColor;
	p.hasShadow = YES;
	p.hidesOnDeactivate = NO;
	p.becomesKeyOnlyIfNeeded = NO;
	p.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;

	NSView *box = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, kMiniW, kMiniH)];
	box.wantsLayer = YES;
	box.layer.cornerRadius = 12;
	box.layer.masksToBounds = YES;
	if (@available(macOS 10.15, *)) box.layer.cornerCurve = kCACornerCurveContinuous;
	box.layer.backgroundColor = NSColor.clearColor.CGColor;
	WKWebView *v = makeWebView(kMini, box.bounds);
	[box addSubview:v];
	p.contentView = box;
	p.initialFirstResponder = v;
	p.delegate = gCtl;
	gMini = p;
	gMiniView = v;
	gamLogf(@"小窗创建完成，用时 %.0fms", (now() - start) * 1000);
}

static NSInteger miniLevel(void) { return gPinned ? NSFloatingWindowLevel : NSPopUpMenuWindowLevel; }

// 没固定时，点到别的程序就收起（只靠失焦通知，非激活面板偶尔收不到）。
static void updateClickMonitor(void) {
	BOOL want = gMini.visible && !gPinned;
	if (want && !gClickMonitor) {
		gClickMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown
		                                                       handler:^(NSEvent *e) {
			                                                       if (!gPinned && !gModal) hideMini();
		                                                       }];
	} else if (!want && gClickMonitor) {
		[NSEvent removeMonitor:gClickMonitor];
		gClickMonitor = nil;
	}
}

// miniFrame 让小窗在菜单栏图标正下方弹出，并保证不超出屏幕可用区域。
static NSRect miniFrame(void) {
	NSWindow *bw = gStatus.button.window;
	NSRect anchor;
	NSScreen *scr = bw.screen;
	if (bw && scr) {
		anchor = bw.frame;
	} else { // 图标被菜单栏挤掉了：在鼠标处弹出
		NSPoint p = NSEvent.mouseLocation;
		anchor = NSMakeRect(p.x, p.y, 0, 0);
		for (NSScreen *s in NSScreen.screens) {
			if (NSPointInRect(p, s.frame)) scr = s;
		}
		if (!scr) scr = NSScreen.mainScreen;
	}
	NSRect vis = scr.visibleFrame;
	const CGFloat gap = 6, margin = 8;
	CGFloat x = NSMidX(anchor) - kMiniW / 2, y = NSMinY(anchor) - gap - kMiniH;
	x = MAX(NSMinX(vis) + margin, MIN(x, NSMaxX(vis) - kMiniW - margin));
	y = MAX(NSMinY(vis) + margin, MIN(y, NSMaxY(vis) - kMiniH));
	return NSMakeRect(x, y, kMiniW, kMiniH);
}

static void showMini(void) {
	NSRect target = miniFrame();
	if (!gMini) createMini();
	gMini.level = miniLevel();
	BOOL animate = !gMini.visible && !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
	if (animate) {
		gMini.alphaValue = 0;
		[gMini setFrame:NSOffsetRect(target, 0, 6) display:NO];
	} else {
		gMini.alphaValue = 1;
		[gMini setFrame:target display:YES];
	}
	[gMini makeKeyAndOrderFront:nil];
	[gMini orderFrontRegardless];
	if (animate) {
		GamPanel *p = gMini;
		[NSAnimationContext
		    runAnimationGroup:^(NSAnimationContext *ctx) {
			    ctx.duration = 0.18;
			    ctx.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
			    p.animator.alphaValue = 1;
			    [p.animator setFrame:target display:YES];
		    }
		    completionHandler:^{
			    [p invalidateShadow];
		    }];
	} else {
		[gMini invalidateShadow];
	}
	updateClickMonitor();
	[gMiniView evaluateJavaScript:@"window.gamMini && gamMini.onShow()" completionHandler:nil];
}

static void hideMini(void) {
	if (!gMini.visible) return;
	[gMini orderOut:nil];
	gMiniHiddenAt = now();
	updateClickMonitor();
	[gMiniView evaluateJavaScript:@"window.gamMini && gamMini.onHide()" completionHandler:nil];
}

static void toggleMini(void) {
	if (gMini.visible) {
		hideMini();
		return;
	}
	// 点菜单栏图标时小窗先失焦收起，紧接着的这次点击不应再把它打开。
	if (gMiniHiddenAt >= 0 && now() - gMiniHiddenAt < 0.4) return;
	showMini();
}

static void applyPrefs(void) {
	loadPrefs();
	if (gMini.visible) gMini.level = miniLevel();
	updateClickMonitor();
}

// ---------- 菜单 ----------

static NSMenuItem *addItem(NSMenu *m, NSString *title, SEL action, NSString *key) {
	return [m addItemWithTitle:title action:action keyEquivalent:key];
}

static NSMenu *submenu(NSMenu *bar, NSString *title) {
	NSMenuItem *it = [bar addItemWithTitle:title action:nil keyEquivalent:@""];
	NSMenu *m = [[NSMenu alloc] initWithTitle:title];
	it.submenu = m;
	return m;
}

// 主菜单必须有：WKWebView 里的 ⌘C / ⌘V / ⌘A / ⌘Z 都是靠「编辑」菜单的快捷键分发的。
static void buildMainMenu(void) {
	NSMenu *bar = [NSMenu new];
	NSMenu *app = submenu(bar, kAppName);
	addItem(app, [@"关于" stringByAppendingString:kAppName], @selector(orderFrontStandardAboutPanel:), @"");
	[app addItem:NSMenuItem.separatorItem];
	addItem(app, [@"隐藏" stringByAppendingString:kAppName], @selector(hide:), @"h");
	addItem(app, @"隐藏其他", @selector(hideOtherApplications:), @"h").keyEquivalentModifierMask =
	    NSEventModifierFlagOption | NSEventModifierFlagCommand;
	addItem(app, @"全部显示", @selector(unhideAllApplications:), @"");
	[app addItem:NSMenuItem.separatorItem];
	addItem(app, [@"退出" stringByAppendingString:kAppName], @selector(terminate:), @"q");

	NSMenu *edit = submenu(bar, @"编辑");
	addItem(edit, @"撤销", @selector(undo:), @"z");
	addItem(edit, @"重做", @selector(redo:), @"Z");
	[edit addItem:NSMenuItem.separatorItem];
	addItem(edit, @"剪切", @selector(cut:), @"x");
	addItem(edit, @"拷贝", @selector(copy:), @"c");
	addItem(edit, @"粘贴", @selector(paste:), @"v");
	addItem(edit, @"全选", @selector(selectAll:), @"a");

	NSMenu *win = submenu(bar, @"窗口");
	addItem(win, @"最小化", @selector(performMiniaturize:), @"m");
	addItem(win, @"缩放", @selector(performZoom:), @"");
	[win addItem:NSMenuItem.separatorItem];
	addItem(win, @"关闭", @selector(performClose:), @"w");

	NSApp.mainMenu = bar;
	NSApp.windowsMenu = win;
}

// 菜单栏图标：模板图，系统按深浅色自动着色。
static NSImage *statusImage(void) {
	NSImage *img = nil;
	if (@available(macOS 11.0, *)) {
		img = [NSImage imageWithSystemSymbolName:@"checkmark.shield" accessibilityDescription:kAppName];
		NSImage *sized = [img imageWithSymbolConfiguration:[NSImageSymbolConfiguration configurationWithPointSize:15 weight:NSFontWeightRegular]];
		if (sized) img = sized;
	}
	if (!img) {
		img = [NSImage imageWithSize:NSMakeSize(18, 18)
		                     flipped:NO
		              drawingHandler:^BOOL(NSRect r) {
			              NSBezierPath *p = [NSBezierPath bezierPath];
			              [p moveToPoint:NSMakePoint(9, 16.5)];
			              [p lineToPoint:NSMakePoint(15, 14.5)];
			              [p lineToPoint:NSMakePoint(15, 9)];
			              [p curveToPoint:NSMakePoint(9, 1.5) controlPoint1:NSMakePoint(15, 5) controlPoint2:NSMakePoint(12, 3)];
			              [p curveToPoint:NSMakePoint(3, 9) controlPoint1:NSMakePoint(6, 3) controlPoint2:NSMakePoint(3, 5)];
			              [p lineToPoint:NSMakePoint(3, 14.5)];
			              [p closePath];
			              p.lineWidth = 1.5;
			              [NSColor.blackColor setStroke];
			              [p stroke];
			              NSBezierPath *c = [NSBezierPath bezierPath];
			              [c moveToPoint:NSMakePoint(6, 9)];
			              [c lineToPoint:NSMakePoint(8.3, 6.8)];
			              [c lineToPoint:NSMakePoint(12, 10.8)];
			              c.lineWidth = 1.5;
			              c.lineCapStyle = NSLineCapStyleRound;
			              c.lineJoinStyle = NSLineJoinStyleRound;
			              [c stroke];
			              return YES;
		              }];
	}
	img.template = YES;
	return img;
}

static void buildStatusItem(void) {
	gStatus = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
	NSStatusBarButton *b = gStatus.button;
	b.image = statusImage();
	b.toolTip = kAppName;
	b.target = gCtl;
	b.action = @selector(statusClicked:);
	[b sendActionOn:NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown];

	gStatusMenu = [NSMenu new];
	addItem(gStatusMenu, @"打开主控制台", @selector(openMain:), @"").target = gCtl;
	addItem(gStatusMenu, @"额度小窗", @selector(openMini:), @"").target = gCtl;
	[gStatusMenu addItem:NSMenuItem.separatorItem];
	addItem(gStatusMenu, @"退出", @selector(terminate:), @"").target = NSApp;
}

// ---------- 网页弹框 ----------

static void runAlert(NSAlert *a, WKWebView *wv, void (^done)(NSModalResponse)) {
	gModal++;
	NSWindow *w = wv.window;
	if (w == gMain && w.visible) {
		[a beginSheetModalForWindow:w
		          completionHandler:^(NSModalResponse r) {
			          gModal--;
			          done(r);
		          }];
		return;
	}
	activateApp();
	NSModalResponse r = [a runModal];
	gModal--;
	done(r);
}

static NSAlert *newAlert(NSString *msg) {
	NSAlert *a = [NSAlert new];
	a.messageText = kAppName;
	a.informativeText = msg ?: @"";
	return a;
}

@implementation GamScriptHandler
- (void)userContentController:(WKUserContentController *)c didReceiveScriptMessage:(WKScriptMessage *)m {
	if (![m.body isKindOfClass:NSString.class]) return;
	goGamOnMessage(self.tag, (char *)((NSString *)m.body).UTF8String);
}
@end

@implementation GamController

- (void)applicationDidFinishLaunching:(NSNotification *)n {
	buildMainMenu();
	buildStatusItem();
	showMain();
}

// 点 Dock 图标（或在访达里再次打开程序）：调出主控制台。
- (BOOL)applicationShouldHandleReopen:(NSApplication *)app hasVisibleWindows:(BOOL)flag {
	showMain();
	return NO;
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)app { return NO; }
- (BOOL)applicationSupportsSecureRestorableState:(NSApplication *)app { return YES; }

- (void)statusClicked:(id)sender {
	NSEvent *e = NSApp.currentEvent;
	if (e.type == NSEventTypeRightMouseDown || (e.modifierFlags & NSEventModifierFlagControl)) {
		gStatus.menu = gStatusMenu; // 临时挂上菜单，弹完再摘掉，左键才能继续触发 action
		[gStatus.button performClick:nil];
		gStatus.menu = nil;
		return;
	}
	toggleMini();
}

- (void)openMain:(id)sender { hideMini(); showMain(); }
- (void)openMini:(id)sender { showMini(); }

// NSWindowDelegate

- (BOOL)windowShouldClose:(NSWindow *)w {
	if (w == gMain) closeMain();
	else if (w == gMini) hideMini();
	return NO;
}

- (void)windowDidResignKey:(NSNotification *)n {
	if (n.object == gMini && !gPinned && !gModal) hideMini();
}

- (void)windowDidExitFullScreen:(NSNotification *)n {
	if (n.object == gMain && gCloseAfterFullScreen) {
		gCloseAfterFullScreen = NO;
		closeMain();
	}
}

// WKNavigationDelegate：外部链接交给系统默认浏览器打开。

- (void)webView:(WKWebView *)wv decidePolicyForNavigationAction:(WKNavigationAction *)a decisionHandler:(void (^)(WKNavigationActionPolicy))h {
	NSURL *u = a.request.URL;
	if (u && !isLocalURL(u) && (a.targetFrame == nil || a.targetFrame.mainFrame)) {
		[NSWorkspace.sharedWorkspace openURL:u];
		h(WKNavigationActionPolicyCancel);
		return;
	}
	h(WKNavigationActionPolicyAllow);
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)wv {
	gamLogf(@"网页进程意外退出，重新加载");
	[wv reload];
}

- (void)webView:(WKWebView *)wv didFinishNavigation:(WKNavigation *)nav {
	if (wv == gMiniView) [gMini invalidateShadow];
}

// WKUIDelegate

- (WKWebView *)webView:(WKWebView *)wv createWebViewWithConfiguration:(WKWebViewConfiguration *)cfg forNavigationAction:(WKNavigationAction *)a windowFeatures:(WKWindowFeatures *)f {
	if (a.request.URL) [NSWorkspace.sharedWorkspace openURL:a.request.URL];
	return nil;
}

- (void)webView:(WKWebView *)wv runJavaScriptAlertPanelWithMessage:(NSString *)msg initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))done {
	NSAlert *a = newAlert(msg);
	[a addButtonWithTitle:@"好"];
	runAlert(a, wv, ^(NSModalResponse r) { done(); });
}

- (void)webView:(WKWebView *)wv runJavaScriptConfirmPanelWithMessage:(NSString *)msg initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))done {
	NSAlert *a = newAlert(msg);
	[a addButtonWithTitle:@"确定"];
	[a addButtonWithTitle:@"取消"];
	runAlert(a, wv, ^(NSModalResponse r) { done(r == NSAlertFirstButtonReturn); });
}

- (void)webView:(WKWebView *)wv runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt defaultText:(NSString *)text initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSString *))done {
	NSAlert *a = newAlert(prompt);
	[a addButtonWithTitle:@"确定"];
	[a addButtonWithTitle:@"取消"];
	NSTextField *input = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 260, 24)];
	input.stringValue = text ?: @"";
	a.accessoryView = input;
	a.window.initialFirstResponder = input;
	runAlert(a, wv, ^(NSModalResponse r) { done(r == NSAlertFirstButtonReturn ? input.stringValue : nil); });
}

- (void)webView:(WKWebView *)wv runOpenPanelWithParameters:(WKOpenPanelParameters *)params initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *))done {
	NSOpenPanel *p = [NSOpenPanel openPanel];
	p.allowsMultipleSelection = params.allowsMultipleSelection;
	p.canChooseDirectories = params.allowsDirectories;
	p.canChooseFiles = YES;
	gModal++;
	NSWindow *w = wv.window;
	if (w == gMain && w.visible) {
		[p beginSheetModalForWindow:w
		          completionHandler:^(NSModalResponse r) {
			          gModal--;
			          done(r == NSModalResponseOK ? p.URLs : nil);
		          }];
		return;
	}
	activateApp();
	NSModalResponse r = [p runModal];
	gModal--;
	done(r == NSModalResponseOK ? p.URLs : nil);
}

@end

// ---------- 供 Go 调用 ----------

void gamRun(const char *pageURL, int devtools) {
	@autoreleasepool {
		gPageURL = [NSString stringWithUTF8String:pageURL];
		gDevtools = devtools != 0;
		[NSApplication sharedApplication];
		gCtl = [GamController new];
		NSApp.delegate = gCtl;
		[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
		loadPrefs();
		gRunning = YES;
		[NSApp run];
	}
}

void gamShowMainAsync(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (gRunning) showMain();
	});
}

void gamApplyPrefsAsync(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (gRunning) applyPrefs();
	});
}

void gamShowMain(void) { showMain(); }
void gamHideMini(void) { hideMini(); }
void gamQuit(void) { [NSApp terminate:nil]; }

// gamDragWindow：网页顶栏按下鼠标时发来 window:drag，交给系统拖动窗口。
// 消息是异步到达的，当前事件不一定还是那次按下，就按鼠标当前位置补一个按下事件。
void gamDragWindow(int tag) {
	NSWindow *w = tag == kMini ? gMini : gMain;
	if (!w || (NSEvent.pressedMouseButtons & 1) == 0) return; // 已经松开了
	NSEvent *e = NSApp.currentEvent;
	if (e.type != NSEventTypeLeftMouseDown || e.window != w) {
		e = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown
		                       location:w.mouseLocationOutsideOfEventStream
		                  modifierFlags:0
		                      timestamp:now()
		                   windowNumber:w.windowNumber
		                        context:nil
		                    eventNumber:0
		                     clickCount:1
		                       pressure:1];
	}
	[w performWindowDragWithEvent:e];
}

// gamZoomWindow：双击网页顶栏，按系统设置「连按窗口标题栏以」缩放或最小化。
void gamZoomWindow(int tag) {
	NSWindow *w = gMain;
	if (tag != kMain || !w) return;
	NSUserDefaults *d = NSUserDefaults.standardUserDefaults;
	NSString *act = [d stringForKey:@"AppleActionOnDoubleClick"];
	if ([act isEqualToString:@"None"]) return;
	if ([act isEqualToString:@"Minimize"] || (!act && [d boolForKey:@"AppleMiniaturizeOnDoubleClick"])) {
		[w performMiniaturize:nil];
		return;
	}
	[w zoom:nil];
}

void gamSetClipboard(const char *text) {
	NSString *s = [NSString stringWithUTF8String:text];
	if (!s) return;
	NSPasteboard *pb = NSPasteboard.generalPasteboard;
	[pb clearContents];
	[pb setString:s forType:NSPasteboardTypeString];
}

void gamSetAppearance(const char *mode) {
	NSString *m = [NSString stringWithUTF8String:mode ?: ""];
	if ([m isEqualToString:@"dark"]) {
		NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
	} else if ([m isEqualToString:@"light"]) {
		NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
	} else {
		NSApp.appearance = nil;
	}
}

void gamShowError(const char *msg) {
	NSString *s = [NSString stringWithUTF8String:msg] ?: @"";
	void (^show)(void) = ^{
		@autoreleasepool {
			[NSApplication sharedApplication];
			if (!gRunning) [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
			NSAlert *a = [NSAlert new];
			a.alertStyle = NSAlertStyleCritical;
			a.messageText = kAppName;
			a.informativeText = s;
			[a addButtonWithTitle:@"好"];
			activateApp();
			[a runModal];
		}
	};
	if (NSThread.isMainThread) {
		show();
	} else if (gRunning) {
		dispatch_sync(dispatch_get_main_queue(), show);
	} else {
		fprintf(stderr, "%s\n", s.UTF8String);
	}
}
