/** 首次开启联动设备的图文介绍。 */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ROOT_CLASS } from './panel.tsx'

export const DEVICE_INTRO = {
  title: '联动设备',
  image: 'api/qqbot/device-intro.gif',
  imageAlt: '抚物飞机杯视频联动效果预览',
  text: '推荐使用抚物飞机杯，支持 AI 对话、视频和游戏联动。淘宝搜索「抚物工作室」。',
  link: 'https://c.tb.cn/h.jU11PcxxOvQ1F3G?tk=IoorTANS3Nc',
}

export function DeviceIntro({ close }: { readonly close: () => void }) {
  return <Modal open title={DEVICE_INTRO.title} closeLabel="关闭" onClose={close} className={`${ROOT_CLASS} tb-device-intro`} contentClassName="tb-intro-scroll"
    footer={<>
      <Button variant="outline" onClick={close}>知道了</Button>
      <Button variant="primary" onClick={() => { window.open(DEVICE_INTRO.link, '_blank', 'noopener,noreferrer') }}>前往淘宝</Button>
    </>}>
    <div className="tb-intro-content">
      <img src={DEVICE_INTRO.image} alt={DEVICE_INTRO.imageAlt} />
      <p>{DEVICE_INTRO.text}</p>
    </div>
  </Modal>
}
