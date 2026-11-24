"""
Microsoft Graph API を使用したメール送信機能
Client Credentials フロー (アプリケーション認証) を使用
"""
import os
import json
from urllib.parse import urljoin

import requests
from azure.identity import ClientSecretCredential


class GraphMailSender:
    """Microsoft Graph API でメールを送信するクラス"""
    
    def __init__(self):
        """Azure AD の認証情報から認証オブジェクトを初期化"""
        self.tenant_id = os.getenv("AZURE_TENANT_ID", "")
        self.client_id = os.getenv("AZURE_CLIENT_ID", "")
        self.client_secret = os.getenv("AZURE_CLIENT_SECRET", "")
        self.mailbox_email = os.getenv("GRAPH_MAILBOX_EMAIL", "")
        
        self.enabled = bool(self.tenant_id and self.client_id and self.client_secret and self.mailbox_email)
        
        if self.enabled:
            try:
                self.credential = ClientSecretCredential(
                    tenant_id=self.tenant_id,
                    client_id=self.client_id,
                    client_secret=self.client_secret,
                )
            except Exception as e:
                print(f"⚠️ Graph API 初期化失敗: {e}")
                self.enabled = False

    def _get_access_token(self):
        """アクセストークンを取得"""
        if not self.enabled:
            return None
        try:
            token = self.credential.get_token("https://graph.microsoft.com/.default")
            return token.token
        except Exception as e:
            print(f"❌ アクセストークン取得エラー: {e}")
            return None

    def send_email(self, recipient_email: str, subject: str, body: str, is_html: bool = False) -> bool:
        """
        Microsoft Graph API でメールを送信
        
        Args:
            recipient_email: 受信者のメールアドレス
            subject: メール件名
            body: メール本文
            is_html: True の場合、本文を HTML として送信
        
        Returns:
            成功時 True、失敗時 False
        """
        if not self.enabled:
            print("⚠️ Graph API が有効になっていません。メール送信はスキップされます。")
            return False
        
        if not recipient_email or not subject or not body:
            print("❌ 受信者、件名、本文は必須です。")
            return False
        
        access_token = self._get_access_token()
        if not access_token:
            print("❌ アクセストークン取得に失敗しました。")
            return False
        
        # Graph API のメール送信エンドポイント
        url = f"https://graph.microsoft.com/v1.0/users/{self.mailbox_email}/sendMail"
        
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }
        
        payload = {
            "message": {
                "subject": subject,
                "body": {
                    "contentType": "HTML" if is_html else "Text",
                    "content": body,
                },
                "toRecipients": [
                    {"emailAddress": {"address": recipient_email}}
                ],
            },
            "saveToSentItems": True,
        }
        
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=10)
            if response.status_code == 202:
                print(f"✅ メール送信成功: {recipient_email}")
                return True
            else:
                print(f"❌ メール送信失敗 ({response.status_code}): {response.text}")
                return False
        except Exception as e:
            print(f"❌ メール送信エラー: {e}")
            return False


def send_workflow_advancement_email(
    recipient_email: str,
    recipient_name: str,
    record_id: int,
    trial_no: str,
    project_name: str,
    stage_name: str,
    current_manager: str,
) -> bool:
    """
    回覧が進行したときに次の担当者にメールを送信
    
    Args:
        recipient_email: 受信者のメールアドレス
        recipient_name: 受信者の名前
        record_id: 記録ID
        trial_no: 試験番号
        project_name: プロジェクト名
        stage_name: 段階名
        current_manager: 現在の対応者の担当者名
    
    Returns:
        成功時 True、失敗時 False
    """
    sender = GraphMailSender()
    
    if not sender.enabled:
        return False
    
    # メール件名と本文を作成
    subject = f"【試験記録回覧】{trial_no} - {project_name}"
    body = f"""{recipient_name} 様

お疲れさまです。

以下の試験記録の回覧が、{current_manager} 様から{recipient_name} 様に進行いたしました。
ご対応をお願いいたします。

【試験記録情報】
  試験番号: {trial_no}
  プロジェクト: {project_name}
  段階: {stage_name}
  記録ID: {record_id}

システムにアクセスしてご対応ください。

---
このメールは試験記録システムから自動配信されています。
返信の必要はありません。
"""
    
    return sender.send_email(recipient_email, subject, body)
