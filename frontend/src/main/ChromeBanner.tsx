import { AppWindow, X } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../lib/api";
import { app, dismissBanner, reloadAccounts, visibleAccounts } from "../lib/app";
import { useStore } from "../lib/store";
import { errText, toast } from "../lib/toast";
import { Button, IconButton } from "../ui/button";
import { Collapse } from "../ui/form";
import { ConfirmPop } from "../ui/overlay";

/** 只有还有号在用日常 Chrome 资料时才出现，可以忽略。 */
export function ChromeBanner() {
  const n = useStore(app, (s) => visibleAccounts(s).filter((a) => a.chrome_profile).length);
  const dismissed = useStore(app, (s) => s.bannerDismissed);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <Collapse open={n > 0 && !dismissed}>
      <div className="mb-1.5 flex items-center gap-2.5 rounded-[14px] bg-surface px-3 py-2 shadow-raised">
        <AppWindow size={15} strokeWidth={1.9} className="shrink-0 text-ink-3" />
        <p className="min-w-0 flex-1 text-sm text-ink-2">
          有 <b className="font-semibold text-ink">{n}</b> 个号还在用日常 Chrome 的资料打开。换成自带浏览器后，Chrome 里的旧资料就能删了。
        </p>
        <Button ref={ref} size="xs" variant="soft" onClick={() => setConfirm(true)}>
          全部换成自带
        </Button>
        <IconButton icon={X} label="不再提示" size="xs" onClick={dismissBanner} />
        <ConfirmPop
          open={confirm}
          onClose={() => setConfirm(false)}
          anchor={ref}
          title={`把这 ${n} 个号换成自带浏览器？`}
          message="之后每个号第一次打开要重新登录一次（密码和 2FA 在这里一键复制）。头像会先存下来。"
          confirmLabel="全部换成自带"
          onConfirm={async () => {
            try {
              const r = await api.detachChrome();
              await reloadAccounts();
              toast.ok(`${r.converted} 个号换成自带浏览器了`);
            } catch (e) {
              toast.err(errText(e));
            }
          }}
        />
      </div>
    </Collapse>
  );
}
