
export enum Sender {
  User = 'user',
  AI = 'ai',
}

export interface Message {
  sender: Sender;
  text: string;
  isFinal?: boolean;
}
