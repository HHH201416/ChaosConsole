import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import './index.css'

/**
 * 9.5.5：最外层再兜一层 —— 连 App 自己（启动画面 / 登录页）出错也不会只剩黑窗口。
 * 任何一个 .map 崩掉都不该让用户看到一片空白。
 */
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary label="应用">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
