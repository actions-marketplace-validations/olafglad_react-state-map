import React from 'react';
import { Button } from './Button';

interface OldWidgetProps {
  label: string;
}

export class OldWidget extends React.Component<OldWidgetProps, { clicks: number }> {
  state = { clicks: 0 };

  render() {
    return <Button text={`${this.props.label} ${this.state.clicks}`} />;
  }
}
